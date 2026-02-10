/**
 * Persistent storage for agent wallets and jobs
 * Saves to data/ directory as JSON files
 * Survives Railway deploys
 */
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const WALLETS_FILE = path.join(DATA_DIR, "wallets.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

// === WALLET PERSISTENCE ===

interface SerializedWallet {
  agentId: string;
  secretKey: number[];  // Uint8Array as number[]
  tokenAccount: string; // PublicKey as base58
}

export function saveWallets(wallets: Map<string, { keypair: Keypair; tokenAccount?: PublicKey }>): void {
  const data: SerializedWallet[] = [];
  for (const [agentId, w] of wallets) {
    data.push({
      agentId,
      secretKey: Array.from(w.keypair.secretKey),
      tokenAccount: w.tokenAccount?.toBase58() || "",
    });
  }
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2));
  console.log(`[Persistence] Saved ${data.length} wallets`);
}

export function loadWallets(): Map<string, { keypair: Keypair; tokenAccount?: PublicKey }> {
  const wallets = new Map<string, { keypair: Keypair; tokenAccount?: PublicKey }>();
  if (!fs.existsSync(WALLETS_FILE)) return wallets;
  
  try {
    const data: SerializedWallet[] = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
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

export function saveJobs(jobs: Map<number, any>): void {
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
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
  console.log(`[Persistence] Saved ${data.length} jobs`);
}

export function loadJobs(): Map<number, any> {
  const jobs = new Map<number, any>();
  if (!fs.existsSync(JOBS_FILE)) return jobs;
  
  try {
    const data: PersistedJob[] = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    for (const job of data) {
      jobs.set(job.escrowId, job);
    }
    console.log(`[Persistence] Loaded ${jobs.size} jobs`);
  } catch (e: any) {
    console.error(`[Persistence] Failed to load jobs: ${e.message}`);
  }
  return jobs;
}
