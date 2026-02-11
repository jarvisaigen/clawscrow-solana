/**
 * Clawscrow Backend API
 * 
 * Lightweight Node.js server for:
 * - Job listing & discovery
 * - File upload/download with ECIES encryption
 * - Arbitration trigger
 * - Agent instructions
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { arbitrate, submitRulingOnChain } from "./arbitrator";
import { uploadFile, getFileMeta, downloadFile, listFiles } from "./files";
import { eciesEncrypt, eciesDecrypt, hashContent, encryptForDelivery, decryptDelivery } from "./encryption";
import { generateKeyPair, decryptWithPrivateKey } from "./ecies";
import { saveJobs, loadJobs } from "./persistence";
import * as storage from "./storage";
import * as fs from "fs";
import * as path from "path";
// crypto imported via createHash below

const PORT = process.env.PORT || 3051;
const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7";
const PROGRAM_PUBKEY = new PublicKey(PROGRAM_ID);
const UPLOAD_DIR = path.join(__dirname, "../uploads");

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Solana connection for on-chain reads
const connection = new Connection(DEVNET_URL, "confirmed");

// Anchor discriminator for "Escrow" account = sha256("account:Escrow")[0..8]
import { createHash } from "crypto";
const ESCROW_DISCRIMINATOR = createHash("sha256").update("account:Escrow").digest().subarray(0, 8);

// State enum mapping (byte 168)
const STATE_MAP: Record<number, string> = {
  0: "created",
  1: "accepted",
  2: "delivered",
  3: "approved",
  4: "disputed",
  5: "resolved_buyer",
  6: "resolved_seller",
  7: "cancelled",
};

// In-memory job store for metadata not on-chain (description, fileId, etc.)
interface JobMeta {
  escrowId: number;
  description: string;
  fileId?: string;
  createdAt: number;
}

interface Job {
  escrowId: number;
  description: string;
  buyer: string;
  seller?: string;
  arbitrator?: string;
  paymentAmount: number;
  buyerCollateral: number;
  sellerCollateral: number;
  state: string;
  createdAt: number;
  deliveryHash?: string;
  fileId?: string;
  deliveredAt?: number;
  onChain: boolean;
}

const jobMeta: Map<number, JobMeta> = new Map();

// Parse on-chain escrow account data (699 bytes) into a Job
function parseEscrowAccount(data: Buffer, meta?: JobMeta): Job {
  // Layout: 8 disc + 8 id(@8) + 32 buyer(@16) + 32 seller(@48) + 32 arb(@80)
  // + 8 pay(@112) + 8 buyCol(@120) + 8 selCol(@128) + 8 deadline(@136)
  // + 4+500 desc(@144) + 1 state(@648) + 32 hash(@649)
  // + 8 created(@681) + 8 delivered(@689) + 1 bump(@697) + 1 vaultBump(@698)
  const escrowId = Number(data.readBigUInt64LE(8));
  const buyer = new PublicKey(data.subarray(16, 48)).toBase58();
  const seller = new PublicKey(data.subarray(48, 80)).toBase58();
  const arbitrator = new PublicKey(data.subarray(80, 112)).toBase58();
  const paymentAmount = Number(data.readBigUInt64LE(112));
  const buyerCollateral = Number(data.readBigUInt64LE(120));
  const sellerCollateral = Number(data.readBigUInt64LE(128));
  const descLen = Math.min(data.readUInt32LE(144), 500);
  const description = data.subarray(148, 148 + descLen).toString("utf-8");
  // Borsh serializes string at actual length, state follows dynamically
  let off = 148 + descLen;
  const stateVal = data[off]; off += 1;
  const state = STATE_MAP[stateVal] || `unknown(${stateVal})`;
  off += 32; // delivery_hash
  const createdAt = Number(data.readBigInt64LE(off)) * 1000; off += 8;
  const deliveredAt = Number(data.readBigInt64LE(off)) * 1000; off += 8;
  
  const sellerStr = seller === "11111111111111111111111111111111" ? undefined : seller;

  return {
    escrowId,
    description: description || meta?.description || `Escrow #${escrowId}`,
    buyer,
    seller: sellerStr,
    arbitrator,
    paymentAmount,
    buyerCollateral,
    sellerCollateral,
    state,
    createdAt: createdAt || meta?.createdAt || 0,
    deliveredAt,
    fileId: meta?.fileId,
    onChain: true,
  };
}

// Fetch all escrow accounts from chain
async function fetchAllEscrows(): Promise<Job[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_PUBKEY, {
    filters: [
      { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(ESCROW_DISCRIMINATOR) } },
    ],
  });
  
  return accounts.map(({ account }) => {
    const data = account.data;
    const escrowId = Number(data.readBigUInt64LE(8));
    return parseEscrowAccount(data, jobMeta.get(escrowId));
  });
}

// Fetch single escrow by ID from chain
async function fetchEscrowById(escrowId: number): Promise<Job | null> {
  const escrowIdBuf = Buffer.alloc(8);
  escrowIdBuf.writeBigUInt64LE(BigInt(escrowId));
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), escrowIdBuf],
    PROGRAM_PUBKEY
  );
  
  const accountInfo = await connection.getAccountInfo(escrowPda);
  if (!accountInfo) return null;
  
  return parseEscrowAccount(accountInfo.data, jobMeta.get(escrowId));
}

// Legacy in-memory jobs map (kept for backward compat during transition)
let jobs: Map<number, Job> = new Map();

// File operations are now in files.ts using storage layer

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

// Serve static files from public/
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  let filePath = path.join(__dirname, "../public", url.pathname === "/" ? "/index.html" : url.pathname);
  
  if (!fs.existsSync(filePath)) return false;
  
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    if (!fs.existsSync(filePath)) return false;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
  res.end(data);
  return true;
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // === INSTRUCTIONS ===
    if (pathname === "/api/instructions" && req.method === "GET") {
      return json(res, {
        name: "Clawscrow",
        version: "2.0.0",
        network: "solana-devnet",
        programId: PROGRAM_ID,
        usdcMint: "CMfut37JaZLSXrZFbExqLUfoSq7AV95TZyLtXLyVHzyh",
        arbitrator: "DF26XZhyKWH4MeSQ1yfEQxBB22vg2EYWS2BfkX1fCUZb",
        description: "Trustless USDC escrow with AI arbitration on Solana. Agents sign all transactions with their own keypairs — no custodial backend.",
        architecture: {
          principle: "Non-custodial. The backend NEVER holds agent keypairs or signs transactions on behalf of agents.",
          onChain: "Agents sign transactions locally (CLI: client/agent-client.ts) or via browser wallet (Phantom). All USDC transfers happen on-chain through the Anchor smart contract.",
          backend: "Handles file storage (S3 + ECIES encryption), AI arbitration (Grok 4.1), job tracking, and the web dashboard. Does NOT touch agent funds.",
        },
        agentFlow: {
          setup: [
            "1. Generate a Solana keypair: solana-keygen new -o ~/my-agent.json",
            "2. Fund with SOL (for gas): request airdrop or transfer from existing wallet",
            "3. Fund with test USDC: POST /api/faucet {address: 'YOUR_PUBKEY', amount: 100000000}",
            "   (amount is in raw units: 100000000 = 100 USDC, 6 decimals)",
          ],
          buyerFlow: [
            "1. Create escrow: npx tsx client/agent-client.ts create <keypair> <description> <payment> <buyerCollateral> <sellerCollateral>",
            "   → Signs create_escrow TX, locks USDC + collateral in PDA vault",
            "2. Wait for seller to accept and deliver",
            "3a. Approve: npx tsx client/agent-client.ts approve <keypair> <escrowId>",
            "   → Seller receives payment + both collaterals returned",
            "3b. Dispute: npx tsx client/agent-client.ts dispute <keypair> <escrowId> <reason>",
            "   → Signs raise_dispute TX, triggers Grok 4.1 AI arbitration, ruling executed on-chain",
            "4. If no action within 3 days → anyone can call auto_approve",
          ],
          sellerFlow: [
            "1. Browse available jobs: GET /api/jobs",
            "2. Accept escrow: npx tsx client/agent-client.ts accept <keypair> <escrowId>",
            "   → Signs accept_escrow TX, locks seller collateral",
            "3. Deliver work: npx tsx client/agent-client.ts deliver <keypair> <escrowId> <filePath>",
            "   → File uploaded to S3 (auto-encrypted with ECIES), content hash submitted on-chain",
            "4. Wait for buyer to approve or dispute",
          ],
        },
        smartContract: {
          programId: "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7",
          instructions: {
            create_escrow: "Buyer locks payment + collateral in PDA vault",
            accept_escrow: "Seller locks collateral, commits to work",
            deliver: "Seller submits content hash on-chain",
            approve: "Buyer releases funds to seller",
            raise_dispute: "Buyer escalates to AI arbitration",
            arbitrate: "Arbitrator executes ruling (BuyerWins/SellerWins)",
            auto_approve: "Anyone can trigger after 3-day review window",
          },
          pdaSeeds: {
            escrow: '["escrow", escrow_id_as_u64_le_bytes]',
            vault: '["vault", escrow_id_as_u64_le_bytes]',
          },
        },
        backendEndpoints: {
          "GET /api/instructions": "This documentation",
          "GET /api/config": "Runtime config (programId, usdcMint, arbitrator)",
          "GET /api/jobs": "List escrows (?wallet=ADDR&page=1&limit=50)",
          "GET /api/jobs/:id": "Escrow details",
          "POST /api/jobs": "Register job metadata (after on-chain create_escrow)",
          "PUT /api/jobs/:id/dispute": "Trigger AI arbitration (after on-chain raise_dispute)",
          "POST /api/files": "Upload file (auto-encrypted if escrowId provided)",
          "GET /api/files": "List files (?escrowId= to filter)",
          "GET /api/files/:fileId": "File metadata (?raw=true for download)",
          "POST /api/files/:fileId/decrypt": "Decrypt file (requires wallet signature: { escrowId, wallet, signature, message })",
          "GET /api/rulings": "All AI rulings (public)",
          "GET /api/rulings/:escrowId": "Specific ruling with full analysis",
          "POST /api/faucet": "Mint test USDC (devnet only) {address, amount}",
          "GET /api/escrows": "List escrows directly from chain",
          "GET /health": "Status, uptime, storage type",
        },
        arbitration: {
          demo: "Grok 4.1 via OpenRouter (active)",
          production: ["Claude Opus 4.6", "GPT 5.2", "Gemini 3 Pro", "Grok 4.1 (fallback)"],
          mechanism: "Demo: Grok 4.1 with structured 4-step analysis. Production: 3 models vote, majority wins, Grok as fallback. Always odd number of votes.",
          process: "1. Decrypt delivery (ECIES) → 2. Analyze vs job description → 3. Determine winner → 4. Confidence score → 5. Execute on-chain",
          fee: "1% of buyer collateral",
          transparency: "All rulings are public via /api/rulings — like court proceedings",
        },
      });
    }

    // === JOBS ===
    if (pathname === "/api/jobs" && req.method === "GET") {
      try {
        const onChainJobs = await fetchAllEscrows();
        // Merge with any in-memory-only jobs (not yet on chain)
        const onChainIds = new Set(onChainJobs.map(j => j.escrowId));
        const memOnlyJobs = Array.from(jobs.values()).filter(j => !onChainIds.has(j.escrowId));
        let allJobs = [...onChainJobs, ...memOnlyJobs].sort((a, b) => b.escrowId - a.escrowId);
        
        // Filter by wallet if requested
        const wallet = url.searchParams.get("wallet");
        if (wallet) {
          allJobs = allJobs.filter(j => j.buyer === wallet || j.seller === wallet);
        }
        
        // Pagination
        const page = parseInt(url.searchParams.get("page") || "1");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
        const total = allJobs.length;
        const paged = allJobs.slice((page - 1) * limit, page * limit);
        
        return json(res, { jobs: paged, count: paged.length, total, page, limit, source: "chain+memory" });
      } catch (err: any) {
        // Fallback to in-memory if chain read fails
        const jobList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
        return json(res, { jobs: jobList, count: jobList.length, source: "memory-fallback", error: err.message });
      }
    }

    if (pathname === "/api/jobs" && req.method === "POST") {
      const body = await parseBody(req);
      const { escrowId, description, buyer, paymentAmount, buyerCollateral, sellerCollateral } = body;
      
      if (!escrowId || !description || !buyer) {
        return json(res, { error: "Missing required fields: escrowId, description, buyer" }, 400);
      }

      // Store metadata for chain-read enrichment
      jobMeta.set(escrowId, { escrowId, description, createdAt: Date.now() });

      const job: Job = {
        escrowId,
        description,
        buyer,
        paymentAmount: paymentAmount || 0,
        buyerCollateral: buyerCollateral || 0,
        sellerCollateral: sellerCollateral || 0,
        state: "created",
        createdAt: Date.now(),
        onChain: false,
      };
      jobs.set(escrowId, job); await saveJobs(jobs);
      return json(res, { ok: true, job }, 201);
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^\/]+)$/);
    if (jobMatch && req.method === "GET") {
      const id = parseInt(jobMatch[1]);
      if (isNaN(id)) return json(res, { error: "Invalid job ID" }, 400);
      try {
        const job = await fetchEscrowById(id);
        if (job) return json(res, { job, source: "chain" });
      } catch {}
      // Fallback to in-memory
      const memJob = jobs.get(id);
      if (!memJob) return json(res, { error: "Job not found" }, 404);
      return json(res, { job: memJob, source: "memory" });
    }

    const acceptMatch = pathname.match(/^\/api\/jobs\/(\d+)\/accept$/);
    if (acceptMatch && req.method === "PUT") {
      return json(res, { error: "Deprecated — use POST /api/escrows/accept with {sellerAgentId, escrowId} for on-chain accept" }, 410);
    }

    const deliverMatch = pathname.match(/^\/api\/jobs\/(\d+)\/deliver$/);
    if (deliverMatch && req.method === "PUT") {
      return json(res, { error: "Deprecated — use POST /api/escrows/deliver with {sellerAgentId, escrowId, contentHash} for on-chain deliver" }, 410);
    }

    const disputeMatch = pathname.match(/^\/api\/jobs\/(\d+)\/dispute$/);
    if (disputeMatch && req.method === "PUT") {
      const id = parseInt(disputeMatch[1]);
      let job: Job | null = null;
      try { job = await fetchEscrowById(id); } catch {}
      if (!job) job = jobs.get(id) || null;
      if (!job) return json(res, { error: "Job not found" }, 404);
      
      const body = await parseBody(req);
      job.state = "disputed";

      // Trigger AI arbitration if API keys are available
      const apiKeys = {
        anthropic: process.env.ANTHROPIC_API_KEY || "",
        openai: process.env.OPENAI_API_KEY || "",
        gemini: process.env.GEMINI_API_KEY || "",
        grok: process.env.GROK_API_KEY || process.env.OPENROUTER_API_KEY || "",
      };

      if (apiKeys.grok || (apiKeys.anthropic && apiKeys.openai && apiKeys.gemini)) {
        const escrowData = {
          escrowId: id,
          buyer: job.buyer,
          seller: job.seller || "",
          description: job.description,
          paymentAmount: job.paymentAmount,
          deliveryHash: job.deliveryHash || "",
        };

        // Auto-fetch delivery content if not provided
        let deliveryContent = body.deliveryContent || "No content provided";
        if (!body.deliveryContent) {
          const escrowFiles = await listFiles(id);
          if (escrowFiles.length > 0) {
            const arbFile = escrowFiles.find((f: any) => f.filename.endsWith('.arb'));
            const targetFile = arbFile || escrowFiles[escrowFiles.length - 1];
            const fileData = await downloadFile(targetFile.id);
            if (fileData?.data) {
              let content: Buffer = fileData.data;
              if (targetFile.encrypted) {
                try {
                  const { decryptForArbitrator } = await import("./encryption");
                  content = await decryptForArbitrator(String(id), fileData.data);
                } catch (e: any) {
                  console.error(`[Arbitration] Decrypt failed: ${e.message}`);
                }
              }
              if (targetFile.filename.toLowerCase().includes('.pdf')) {
                const textContent = content.toString("utf8").slice(0, 5000);
                const printableRatio = textContent.split('').filter((c: string) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length / textContent.length;
                if (printableRatio > 0.7) {
                  deliveryContent = textContent;
                } else {
                  deliveryContent = `[PDF file: ${targetFile.filename}, size: ${content.length} bytes. PDF binary content cannot be read as text. Judge based on file metadata, description, and arguments.]`;
                }
              } else {
                deliveryContent = content.toString("utf8").slice(0, 5000);
              }
            }
          }
        }

        const result = await arbitrate(
          escrowData,
          body.buyerArgument || body.reason || "Work was not delivered as described",
          body.sellerArgument || "Work was delivered according to spec",
          deliveryContent,
          apiKeys
        );

        job.state = result.finalRuling === "BuyerWins" ? "resolved_buyer" : "resolved_seller";

        // Persist ruling to storage
        const rulingData = {
          escrowId: id,
          ruling: result,
          buyerArgument: body.buyerArgument || body.reason || "",
          sellerArgument: body.sellerArgument || "",
          timestamp: Date.now(),
        };
        await storage.putJSON(`rulings/${id}.json`, rulingData);

        // Submit ruling on-chain to move funds
        let onChainTx: string | null = null;
        try {
          const { initOnChain, resolveDispute } = await import("./onchain");
          await initOnChain();
          const onChainResult = await resolveDispute(String(id), result.finalRuling);
          onChainTx = onChainResult.txSignature;
          console.log(`[Arbitration] On-chain ruling submitted: ${onChainTx}`);
        } catch (e: any) {
          console.error(`[Arbitration] On-chain ruling failed: ${e.message}`);
        }

        // Schedule file cleanup after 7 days (gives buyer time to download)
        const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        setTimeout(async () => {
          try {
            const { deleteFilesForEscrow } = await import("./files");
            await deleteFilesForEscrow(id);
          } catch (e: any) {
            console.error(`[Cleanup] Failed: ${e.message}`);
          }
        }, CLEANUP_DELAY_MS);
        console.log(`[Cleanup] Files for escrow #${id} scheduled for deletion in 7 days`);

        await saveJobs(jobs);
        return json(res, { ok: true, job, arbitration: result, onChainTx });
      }

      return json(res, { ok: true, job, arbitration: null, message: "API keys not configured — manual arbitration required" });
    }

    // === RULINGS ===
    // Get ruling for a specific escrow
    const rulingMatch = pathname.match(/^\/api\/rulings\/(\d+)$/);
    if (rulingMatch && req.method === "GET") {
      const ruling = await storage.getJSON(`rulings/${rulingMatch[1]}.json`);
      if (ruling) return json(res, ruling);
      return json(res, { error: "No ruling found" }, 404);
    }

    // List all rulings
    if (pathname === "/api/rulings" && req.method === "GET") {
      const keys = await storage.list("rulings");
      const rulings: any[] = [];
      for (const key of keys) {
        if (!key.endsWith(".json")) continue;
        const r = await storage.getJSON(key);
        if (r) rulings.push(r);
      }
      rulings.sort((a: any, b: any) => b.timestamp - a.timestamp);
      return json(res, { rulings, count: rulings.length });
    }

    // === FILES (ECIES-enabled, auto-encrypt by default) ===
    
    // Upload file — auto-encrypts when escrowId is provided
    // Server generates ECIES keypairs per escrow for buyer + arbitrator
    // Buyer decrypts via GET /api/files/:id/decrypt?escrowId=X
    if (pathname === "/api/files" && req.method === "POST") {
      const body = await parseBody(req);
      const { content, filename, contentType, escrowId, uploadedBy, encryptForPubKey, noEncrypt } = body;

      if (!content) {
        return json(res, { error: "Missing required field: content (base64)" }, 400);
      }

      try {
        // Auto-encrypt when escrowId is provided (unless explicitly disabled)
        if (escrowId && !noEncrypt && !encryptForPubKey) {
          const { getOrCreateEscrowKeys } = await import("./encryption");
          const keys = await getOrCreateEscrowKeys(String(escrowId));
          
          // Encrypt for buyer
          const buyerResult = await uploadFile({
            content, filename, contentType, escrowId, uploadedBy,
            encryptForPubKey: keys.buyerPubKey,
          });
          // Encrypt for arbitrator
          const arbResult = await uploadFile({
            content,
            filename: `${filename || "delivery"}.arb`,
            contentType, escrowId, uploadedBy,
            encryptForPubKey: keys.arbitratorPubKey,
          });
          return json(res, {
            ok: true,
            fileId: buyerResult.fileId,
            arbitratorFileId: arbResult.fileId,
            contentHash: buyerResult.contentHash,
            meta: buyerResult.meta,
            encryption: "auto-ecies",
          }, 201);
        } else if (encryptForPubKey) {
          const result = await uploadFile({
            content, filename, contentType, escrowId, uploadedBy, encryptForPubKey,
          });
          return json(res, { ok: true, fileId: result.fileId, contentHash: result.contentHash, meta: result.meta, encryption: "client-ecies" }, 201);
        } else {
          const result = await uploadFile({
            content, filename, contentType, escrowId, uploadedBy,
          });
          return json(res, { ok: true, fileId: result.fileId, contentHash: result.contentHash, meta: result.meta, encryption: "none" }, 201);
        }
      } catch (err: any) {
        return json(res, { error: `Upload failed: ${err.message}` }, 500);
      }
    }

    // Also support legacy upload endpoint
    if (pathname === "/api/files/upload" && req.method === "POST") {
      const body = await parseBody(req);
      const { content, filename, contentType, escrowId, uploadedBy, encryptForPubKey } = body;

      if (!content) {
        return json(res, { error: "Missing required field: content (base64)" }, 400);
      }

      try {
        const result = await uploadFile({ content, filename, contentType, escrowId, uploadedBy, encryptForPubKey });
        return json(res, { ok: true, fileId: result.fileId, contentHash: result.contentHash, hash: result.contentHash }, 201);
      } catch (err: any) {
        return json(res, { error: `Upload failed: ${err.message}` }, 500);
      }
    }

    // List files for an escrow
    if (pathname === "/api/files" && req.method === "GET") {
      const escrowId = url.searchParams.get("escrowId");
      const fileList = await listFiles(escrowId ? parseInt(escrowId) : undefined);
      return json(res, { files: fileList, count: fileList.length });
    }

    // Decrypt file — requires wallet signature to prove identity (buyer or arbitrator)
    // POST /api/files/:id/decrypt  { escrowId, wallet, signature, message }
    // Signature must be ed25519 over `message` by `wallet`, and wallet must be escrow buyer/arbitrator.
    const decryptMatch = pathname.match(/^\/api\/files\/([a-f0-9-]+)\/decrypt$/);
    if (decryptMatch && (req.method === "POST" || req.method === "GET")) {
      // Legacy GET without auth — reject with upgrade instructions
      if (req.method === "GET") {
        return json(res, { 
          error: "Authentication required. Use POST with { escrowId, wallet, signature, message }.",
          hint: "Sign `message` with your wallet's ed25519 key to prove ownership."
        }, 401);
      }

      const fileId = decryptMatch[1];
      const body = await parseBody(req);
      const { escrowId, wallet, signature, message } = body;

      if (!escrowId || !wallet || !signature || !message) {
        return json(res, { error: "Missing required fields: escrowId, wallet, signature, message" }, 400);
      }

      // Verify ed25519 signature
      try {
        const { ed25519 } = await import("@noble/curves/ed25519");
        const walletPubkey = new PublicKey(wallet);
        const sigBytes = typeof signature === "string" ? Buffer.from(signature, "base64") : signature;
        const msgBytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
        const valid = ed25519.verify(sigBytes, msgBytes, walletPubkey.toBytes());
        if (!valid) {
          return json(res, { error: "Invalid signature" }, 403);
        }
      } catch (err: any) {
        return json(res, { error: `Signature verification failed: ${err.message}` }, 403);
      }

      // Check wallet is buyer or arbitrator for this escrow
      const escrow = await fetchEscrowById(escrowId);
      if (!escrow) return json(res, { error: "Escrow not found on-chain" }, 404);

      const isBuyer = escrow.buyer === wallet;
      const isArbitrator = escrow.arbitrator === wallet;
      if (!isBuyer && !isArbitrator) {
        return json(res, { error: "Wallet is not buyer or arbitrator for this escrow" }, 403);
      }
      const role = isArbitrator ? "arbitrator" : "buyer";

      const file = await downloadFile(fileId);
      if (!file) return json(res, { error: "File not found" }, 404);
      if (!file.meta.encrypted) {
        res.writeHead(200, {
          "Content-Type": file.meta.contentType || "text/plain",
          "Content-Disposition": `attachment; filename="${file.meta.filename}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(file.data);
      }
      
      try {
        const { decryptForBuyer, decryptForArbitrator } = await import("./encryption");
        const decrypted = role === "arbitrator"
          ? await decryptForArbitrator(escrowId, file.data)
          : await decryptForBuyer(escrowId, file.data);
        
        const origFilename = file.meta.filename.replace(/\.arb$/, "");
        res.writeHead(200, {
          "Content-Type": file.meta.contentType || "text/plain",
          "Content-Disposition": `attachment; filename="${origFilename}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(decrypted);
      } catch (err: any) {
        return json(res, { error: `Decryption failed: ${err.message}` }, 500);
      }
    }

    // ECIES keypair/decrypt endpoints removed — decrypt now requires wallet signature auth

    // Download file by ID
    const fileMatch = pathname.match(/^\/api\/files\/([a-f0-9-]+)$/);
    if (fileMatch && req.method === "GET") {
      const fileId = fileMatch[1];
      const raw = url.searchParams.get("raw") === "true";

      if (raw) {
        const file = await downloadFile(fileId);
        if (!file) return json(res, { error: "File not found" }, 404);
        res.writeHead(200, {
          "Content-Type": file.meta.encrypted ? "application/octet-stream" : file.meta.contentType,
          "Content-Disposition": `attachment; filename="${file.meta.filename}"`,
          "X-Encrypted": file.meta.encrypted ? "true" : "false",
          "X-Content-Hash": file.meta.contentHash,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(file.data);
      }

      const meta = await getFileMeta(fileId);
      if (!meta) return json(res, { error: "File not found" }, 404);
      return json(res, { file: meta });
    }

    // === FAUCET — mint test USDC to any devnet address ===
    if (pathname === "/api/faucet" && req.method === "POST") {
      const { initOnChain, mintTestUSDC } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.address) return json(res, { error: "Missing address (Solana pubkey)" }, 400);
      const amount = body.amount || 100_000_000; // default 100 USDC
      const result = await mintTestUSDC(body.address, amount);
      return json(res, { ok: true, ...result });
    }

    // === CONFIG — expose runtime config for frontend ===
    if (pathname === "/api/config" && req.method === "GET") {
      const { initOnChain, getConfig } = await import("./onchain");
      await initOnChain();
      const config = getConfig();
      return json(res, config);
    }

    // === CUSTODIAL ENDPOINTS REMOVED ===
    // Agents sign their own transactions locally with their own keypairs.
    // Use client/agent-client.ts or Phantom wallet for on-chain operations.
    // Backend only handles: file storage, AI arbitration, job tracking, faucet.
    if (pathname === "/api/agents/register" && req.method === "POST") {
      return json(res, { error: "Removed — agents manage their own keypairs. Use client/agent-client.ts or Phantom wallet." }, 410);
    }
    if ((pathname === "/api/escrows/create" || pathname === "/api/escrows/accept" || 
         pathname === "/api/escrows/deliver" || pathname === "/api/escrows/approve") && req.method === "POST") {
      return json(res, { error: "Removed — agents sign transactions locally with their own keypairs. Use client/agent-client.ts or Phantom wallet." }, 410);
    }

    if (pathname === "/api/escrows" && req.method === "GET") {
      const { initOnChain, listEscrowsOnChain } = await import("./onchain");
      await initOnChain();
      const escrows = await listEscrowsOnChain();
      return json(res, { escrows, count: escrows.length, source: "chain" });
    }

    // === HEALTH ===
    if (pathname === "/health") {
      return json(res, { status: "ok", uptime: process.uptime(), jobs: jobs.size, storage: storage.storageInfo.useS3 ? "s3" : "local" });
    }

    // Try static files
    if (serveStatic(req, res)) return;

    // 404
    json(res, { error: "Not found" }, 404);
  } catch (error: any) {
    console.error("Server error:", error);
    json(res, { error: error.message }, 500);
  }
});

// Async startup: load persisted data then start server
(async () => {
  try {
    jobs = await loadJobs() as Map<number, Job>;
    console.log(`[Startup] Loaded ${jobs.size} jobs from storage`);
  } catch (e: any) {
    console.error(`[Startup] Failed to load jobs: ${e.message}`);
  }
  
  server.listen(PORT, () => {
    console.log(`🦞 Clawscrow API running on port ${PORT}`);
    console.log(`   Network: Solana Devnet`);
    console.log(`   Program: ${PROGRAM_ID}`);
    console.log(`   Storage: ${storage.storageInfo.useS3 ? `S3 (${storage.storageInfo.bucket})` : 'Local filesystem'}`);
    console.log(`   Docs: http://localhost:${PORT}/api/instructions`);
  });
})();
