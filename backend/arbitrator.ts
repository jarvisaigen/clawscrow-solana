import fetch from "node-fetch";

/**
 * Clawscrow Arbitrator Service
 * 
 * Multi-model AI arbitration for Solana escrow disputes.
 * Calls 3 primary models + 1 fallback, majority wins.
 * 
 * Models: Claude Opus, GPT-5.2, Gemini 3 Pro (primary) + Grok 4.1 (fallback)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as fs from "fs";

// Config
const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7";

interface ArbitrationResult {
  model: string;
  ruling: "BuyerWins" | "SellerWins";
  confidence: number;
  reasoning: string;
}

interface EscrowData {
  escrowId: number;
  buyer: string;
  seller: string;
  description: string;
  paymentAmount: number;
  deliveryHash: string;
}

/**
 * Call an AI model to arbitrate a dispute
 */
async function callArbitrator(
  model: string,
  apiKey: string,
  escrow: EscrowData,
  buyerArgument: string,
  sellerArgument: string,
  deliveryContent: string
): Promise<ArbitrationResult> {
  const systemPrompt = `You are a senior arbitrator for Clawscrow, a trustless AI agent escrow protocol on Solana. You resolve payment disputes between AI agents with the authority and rigor of a commercial arbitration tribunal.

## Your Role
You are the SOLE decision-maker. Your ruling is final, binding, and executed on-chain automatically. There is no appeal. This means you must be thorough, fair, and precise.

## Decision Framework (apply in order)

### Step 1: Contract Compliance
Parse the job description as a contract. Identify every explicit requirement:
- Specific deliverables (format, length, content type)
- Quantitative criteria (word count, number of items, specific data points)
- Qualitative criteria (technical depth, accuracy, relevance)
- Implicit professional standards (coherent writing, factual accuracy, no plagiarism)

### Step 2: Delivery Analysis
Examine the delivered content against each identified requirement:
- Was each explicit requirement met? (binary per requirement)
- For quantitative requirements: measure precisely (count words, items, etc.)
- For qualitative requirements: assess against reasonable professional standards
- Is the content original, coherent, and genuine work product?

### Step 3: Good Faith Assessment
- Did the seller make a genuine attempt to fulfill the contract?
- Is the buyer's dispute legitimate or frivolous?
- Are there signs of bad faith from either party? (e.g., impossibly vague specs used to reject good work, or seller submitting garbage)

### Step 4: Proportionality
- If the delivery meets most but not all requirements, how material are the gaps?
- A minor formatting issue ≠ total failure
- Missing core deliverables = material breach
- Wrong topic entirely = clear seller failure

## AI-Specific Considerations
Both parties are AI agents. Watch for:
- **Gaming:** Seller submitting AI-generated filler that has words but zero substance
- **Specification abuse:** Buyer writing intentionally ambiguous specs to dispute any delivery
- **Hash mismatch:** If delivery hash doesn't match on-chain hash, evidence of tampering
- **Recycled content:** Generic text not customized to the specific job requirements

## Ruling Standards
- **BuyerWins** if: delivery fails to meet material requirements, is off-topic, is significantly below specified standards, or seller acted in bad faith
- **SellerWins** if: delivery substantially fulfills the contract, buyer's complaints are immaterial or subjective preferences beyond the spec, or buyer is acting in bad faith
- **Confidence** 0.0-1.0: reflects how clear-cut the case is. 1.0 = obvious (e.g., empty delivery). 0.5-0.7 = legitimate arguments on both sides. <0.5 should not occur (pick the stronger side).

## Output Format
Respond ONLY with valid JSON:
{"ruling": "BuyerWins" or "SellerWins", "confidence": 0.0-1.0, "reasoning": "2-4 sentence explanation citing specific evidence from the delivery and requirements"}`;

  const paymentDisplay = escrow.paymentAmount >= 1_000_000 
    ? `${escrow.paymentAmount / 1_000_000} USDC` 
    : `${escrow.paymentAmount} USDC (raw units)`;

  const userPrompt = `# DISPUTE — Escrow #${escrow.escrowId}

## Contract (Job Description)
${escrow.description}

## Payment at Stake
${paymentDisplay}

## Buyer's Complaint
${buyerArgument}

## Seller's Defense
${sellerArgument}

## Evidence: Delivered Content
---BEGIN DELIVERY---
${deliveryContent}
---END DELIVERY---

Analyze the contract requirements, evaluate the delivery against each one, and issue your ruling as JSON.`;

  let response: ArbitrationResult;

  try {
    if (model.startsWith("claude")) {
      response = await callClaude(apiKey, systemPrompt, userPrompt, model);
    } else if (model.startsWith("gpt")) {
      response = await callOpenAI(apiKey, systemPrompt, userPrompt, model);
    } else if (model.startsWith("gemini")) {
      response = await callGemini(apiKey, systemPrompt, userPrompt, model);
    } else if (model.startsWith("grok")) {
      response = await callGrok(apiKey, systemPrompt, userPrompt, model);
    } else {
      throw new Error(`Unknown model: ${model}`);
    }
    response.model = model;
    return response;
  } catch (error: any) {
    console.error(`[${model}] Error:`, error.message);
    throw error;
  }
}

async function callClaude(apiKey: string, system: string, user: string, model: string): Promise<ArbitrationResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json() as any;
  const text = data.content?.[0]?.text || "";
  return parseRuling(text, model);
}

async function callOpenAI(apiKey: string, system: string, user: string, model: string): Promise<ArbitrationResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 500,
    }),
  });
  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || "";
  return parseRuling(text, model);
}

async function callGemini(apiKey: string, system: string, user: string, model: string): Promise<ArbitrationResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
      }),
    }
  );
  const data = await res.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseRuling(text, model);
}

async function callGrok(apiKey: string, system: string, user: string, model: string): Promise<ArbitrationResult> {
  // Support both direct xAI API and OpenRouter
  const isOpenRouter = apiKey.startsWith("sk-or-");
  const baseUrl = isOpenRouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.x.ai/v1/chat/completions";
  const modelId = isOpenRouter ? "x-ai/grok-4.1-fast" : "grok-4.1";

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 2000,
      // Enable thinking/reasoning for deeper analysis
      ...(isOpenRouter ? {
        reasoning: { effort: "high" },
      } : {}),
    }),
  });
  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || "";
  const thinking = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || "";
  if (thinking) {
    console.log(`[Grok thinking]: ${thinking.slice(0, 500)}...`);
  }
  return parseRuling(text, model);
}

function parseRuling(text: string, model: string): ArbitrationResult {
  try {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        model,
        ruling: parsed.ruling === "SellerWins" ? "SellerWins" : "BuyerWins",
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    }
  } catch {}
  
  // Fallback: look for keywords
  const lower = text.toLowerCase();
  const ruling = lower.includes("sellerwins") || lower.includes("seller wins")
    ? "SellerWins" : "BuyerWins";
  
  return { model, ruling, confidence: 0.5, reasoning: text.slice(0, 500) };
}

/**
 * Run multi-model arbitration with 3+1 fallback
 */
export async function arbitrate(
  escrow: EscrowData,
  buyerArgument: string,
  sellerArgument: string,
  deliveryContent: string,
  apiKeys: {
    anthropic: string;
    openai: string;
    gemini: string;
    grok: string;
  }
): Promise<{
  finalRuling: "BuyerWins" | "SellerWins";
  votes: ArbitrationResult[];
  unanimous: boolean;
}> {
  const votes: ArbitrationResult[] = [];

  // Demo mode: if only Grok key exists, use single-model arbitration
  const hasPrimaryKeys = apiKeys.anthropic && apiKeys.openai && apiKeys.gemini;

  if (hasPrimaryKeys) {
    // Production: 3 primary models + Grok fallback
    const primaryModels = [
      { name: "claude-opus", key: apiKeys.anthropic },
      { name: "gpt-5.2", key: apiKeys.openai },
      { name: "gemini-3-pro", key: apiKeys.gemini },
    ];

    let failedPrimary = 0;
    const results = await Promise.allSettled(
      primaryModels.map((m) =>
        callArbitrator(m.name, m.key, escrow, buyerArgument, sellerArgument, deliveryContent)
      )
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        votes.push(result.value);
      } else {
        failedPrimary++;
        console.error("Primary model failed:", result.reason);
      }
    }

    // If any primary failed, call fallback (Grok)
    if (failedPrimary > 0 && apiKeys.grok) {
      try {
        const grokResult = await callArbitrator(
          "grok-4.1", apiKeys.grok, escrow, buyerArgument, sellerArgument, deliveryContent
        );
        votes.push(grokResult);
      } catch (e) {
        console.error("Fallback (Grok) also failed:", e);
      }
    }
  } else if (apiKeys.grok) {
    // Demo mode: Grok only
    console.log("[Arbitration] Demo mode — using Grok 4.1 only");
    try {
      const grokResult = await callArbitrator(
        "grok-4.1", apiKeys.grok, escrow, buyerArgument, sellerArgument, deliveryContent
      );
      votes.push(grokResult);
    } catch (e) {
      console.error("Grok arbitration failed:", e);
    }
  }

  // Count votes
  const buyerVotes = votes.filter((v) => v.ruling === "BuyerWins").length;
  const sellerVotes = votes.filter((v) => v.ruling === "SellerWins").length;

  const finalRuling = buyerVotes >= sellerVotes ? "BuyerWins" : "SellerWins";
  const unanimous = buyerVotes === votes.length || sellerVotes === votes.length;

  console.log(`\nArbitration complete: ${finalRuling}`);
  console.log(`Votes: ${buyerVotes} BuyerWins, ${sellerVotes} SellerWins`);
  console.log(`Unanimous: ${unanimous}`);
  votes.forEach((v) => {
    console.log(`  [${v.model}] ${v.ruling} (${(v.confidence * 100).toFixed(0)}%) — ${v.reasoning.slice(0, 100)}`);
  });

  return { finalRuling, votes, unanimous };
}

/**
 * Submit arbitration ruling on-chain
 */
export async function submitRulingOnChain(
  connection: Connection,
  program: Program<any>,
  arbitratorKeypair: Keypair,
  escrowId: anchor.BN,
  ruling: "BuyerWins" | "SellerWins",
  buyerToken: PublicKey,
  sellerToken: PublicKey,
  arbitratorToken: PublicKey
): Promise<string> {
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), escrowId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrowId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  const rulingArg = ruling === "BuyerWins" ? { buyerWins: {} } : { sellerWins: {} };

  const tx = await program.methods
    .arbitrate(escrowId, rulingArg)
    .accounts({
      arbitrator: arbitratorKeypair.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken,
      sellerToken,
      arbitratorToken,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .signers([arbitratorKeypair])
    .rpc();

  console.log(`Ruling submitted on-chain: ${tx}`);
  return tx;
}
