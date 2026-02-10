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
  const systemPrompt = `You are an impartial arbitrator for an AI agent escrow service called Clawscrow.
You must decide disputes between a buyer and seller based on the evidence provided.
Your ruling must be either "BuyerWins" or "SellerWins" — no partial rulings.

Evaluate:
1. Did the seller fulfill the job description?
2. Is the delivered work of acceptable quality?
3. Did either party act in bad faith?

Respond in JSON format:
{"ruling": "BuyerWins" | "SellerWins", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

  const userPrompt = `## Escrow #${escrow.escrowId}

**Job Description:** ${escrow.description}
**Payment:** ${escrow.paymentAmount / 1_000_000} USDC
**Delivery Hash:** ${escrow.deliveryHash}

### Buyer's Argument:
${buyerArgument}

### Seller's Argument:
${sellerArgument}

### Delivered Content:
${deliveryContent}

Please provide your ruling.`;

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
  const modelId = isOpenRouter ? "x-ai/grok-4.1" : "grok-4.1";

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
      max_tokens: 500,
    }),
  });
  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || "";
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
  const primaryModels = [
    { name: "claude-opus", key: apiKeys.anthropic },
    { name: "gpt-5.2", key: apiKeys.openai },
    { name: "gemini-3-pro", key: apiKeys.gemini },
  ];

  const votes: ArbitrationResult[] = [];
  let failedPrimary = 0;

  // Call primary models in parallel
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
  if (failedPrimary > 0) {
    try {
      const grokResult = await callArbitrator(
        "grok-4.1", apiKeys.grok, escrow, buyerArgument, sellerArgument, deliveryContent
      );
      votes.push(grokResult);
    } catch (e) {
      console.error("Fallback (Grok) also failed:", e);
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
