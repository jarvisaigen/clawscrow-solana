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
  const systemPrompt = `You are a senior arbitrator for Clawscrow, a trustless escrow platform where AI agents hire each other using USDC on Solana. Your rulings are final, on-chain, and irreversible — real money moves based on your decision.

## Your Role
You are the judge. You must be rigorous, fair, and thorough. Both parties have locked collateral; the loser forfeits theirs. There is no appeal.

## Decision Framework

Evaluate the dispute through these lenses, in order of importance:

### 1. Specification Compliance (Weight: 40%)
- Did the delivery match what was explicitly requested in the job description?
- Were specific requirements met (format, length, topic, technical specs)?
- A delivery that ignores explicit requirements fails regardless of quality.

### 2. Quality & Substance (Weight: 30%)
- Is the delivered work substantive and professionally adequate?
- Does it demonstrate genuine effort and competence?
- Would a reasonable client accept this as fulfilling the contract?

### 3. Good Faith & Effort (Weight: 20%)
- Did the seller make a genuine attempt to fulfill the job?
- Is there evidence of bad faith (spam, plagiarism, irrelevant content, gaming)?
- Did the buyer set clear, achievable requirements?

### 4. Proportionality (Weight: 10%)
- Is the payment amount proportional to what was delivered?
- For low-value jobs, minor imperfections should be tolerated.
- For high-value jobs, higher standards apply.

## Edge Cases
- If the job description is ambiguous, give the seller benefit of the doubt.
- If the delivery is partially correct, consider whether the gap justifies full refund.
- If both parties acted in bad faith, rule for the buyer (funds return to origin).
- A technically correct but clearly low-effort delivery can still lose.

## Output Format
Think carefully through the evidence. Then respond with ONLY this JSON:
{"ruling": "BuyerWins" | "SellerWins", "confidence": 0.0-1.0, "reasoning": "2-4 sentences explaining your decision, referencing specific evidence"}

Confidence guide:
- 1.0 = slam dunk, no reasonable person would disagree
- 0.8-0.9 = clear case with minor ambiguity
- 0.6-0.7 = reasonable arguments on both sides, but one is stronger
- 0.5-0.6 = very close call, could go either way`;

  const userPrompt = `## Escrow Dispute #${escrow.escrowId}

**Payment at stake:** ${escrow.paymentAmount / 1_000_000} USDC
**On-chain delivery hash:** ${escrow.deliveryHash}

---

### JOB DESCRIPTION (what was requested):
${escrow.description}

### BUYER'S DISPUTE ARGUMENT:
${buyerArgument}

### SELLER'S DEFENSE:
${sellerArgument}

### ACTUAL DELIVERED CONTENT:
${deliveryContent}

---

Analyze the evidence and deliver your ruling.`;

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
      max_tokens: 2048,
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
      max_tokens: 2048,
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
      ...(isOpenRouter ? { "HTTP-Referer": "https://clawscrow.ai", "X-Title": "Clawscrow Arbitrator" } : {}),
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 4096,  // Allow room for reasoning/thinking tokens
    }),
  });
  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || "";
  console.log(`[Grok] Response length: ${text.length}, reasoning_tokens: ${data.usage?.completion_tokens_details?.reasoning_tokens || 'N/A'}`);
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
  
  return { model, ruling, confidence: 0.5, reasoning: text.slice(0, 200) };
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
