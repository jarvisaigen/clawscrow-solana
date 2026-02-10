/**
 * Persistent storage for agent wallets and jobs
 * Uses S3 bucket (Railway) or local filesystem fallback.
 */
import * as storage from "./storage";
import { Keypair, PublicKey } from "@solana/web3.js";

// === WALLET PERSISTENCE ===

interface SerializedWallet {
  agentId: string;
  secretKey: number[];
  tokenAccount: string;
}

export async function saveWallets(wallets: Map<string, { keypair: Keypair; tokenAccount?: PublicKey }>): Promise<void> {
  const data: SerializedWallet[] = [];
  for (const [agentId, w] of wallets) {
    data.push({
      agentId,
      secretKey: Array.from(w.keypair.secretKey),
      tokenAccount: w.tokenAccount?.toBase58() || "",
    });
  }
  await storage.putJSON("wallets.json", data);
  console.log(`[Persistence] Saved ${data.length} wallets`);
}

export async function loadWallets(): Promise<Map<string, { keypair: Keypair; tokenAccount?: PublicKey }>> {
  const wallets = new Map<string, { keypair: Keypair; tokenAccount?: PublicKey }>();
  const data = await storage.getJSON<SerializedWallet[]>("wallets.json");
  if (!data) return wallets;
  
  try {
    for (const entry of data) {
      const keypair = Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
      const tokenAccount = entry.tokenAccount ? new PublicKey(entry.tokenAccount) : undefined;
      wallets.set(entry.agentId, { keypair, tokenAccount });
    }
    console.log(`[Persistence] Loaded ${wallets.size} wallets`);
  } catch (e: any) {
    console.error(`[Persistence] Failed to load wallets: ${e.message}`);
  }
  return wallets;
}

// === JOB PERSISTENCE ===

export interface PersistedJob {
  escrowId: number;
  title?: string;
  description: string;
  buyer: string;
  seller?: string;
  paymentAmount: number;
  buyerCollateral?: number;
  sellerCollateral?: number;
  state: string;
  deliveryContent?: string;
  deliveryHash?: string;
  disputeReason?: string;
  arbitrationResult?: any;
  onChainTx?: string;
  createdAt: number;
  updatedAt: number;
}

export async function saveJobs(jobs: Map<number, any>): Promise<void> {
  const data: PersistedJob[] = [];
  for (const [, job] of jobs) {
    data.push({
      escrowId: job.escrowId || job.id,
      title: job.title,
      description: job.description,
      buyer: job.buyer,
      seller: job.seller,
      paymentAmount: job.paymentAmount,
      buyerCollateral: job.buyerCollateral,
      sellerCollateral: job.sellerCollateral,
      state: job.state,
      deliveryContent: job.deliveryContent,
      deliveryHash: job.deliveryHash,
      disputeReason: job.disputeReason,
      arbitrationResult: job.arbitrationResult,
      onChainTx: job.onChainTx,
      createdAt: job.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
  }
  await storage.putJSON("jobs.json", data);
  console.log(`[Persistence] Saved ${data.length} jobs`);
}

export async function loadJobs(): Promise<Map<number, any>> {
  const jobs = new Map<number, any>();
  const data = await storage.getJSON<PersistedJob[]>("jobs.json");
  if (!data) return jobs;
  
  try {
    for (const job of data) {
      jobs.set(job.escrowId, job);
    }
    console.log(`[Persistence] Loaded ${jobs.size} jobs`);
  } catch (e: any) {
    console.error(`[Persistence] Failed to load jobs: ${e.message}`);
  }
  return jobs;
}
