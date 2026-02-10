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
  5: "resolved_seller",
  6: "resolved_buyer",
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
  paymentAmount: number;
  buyerCollateral: number;
  sellerCollateral: number;
  state: string;
  createdAt: number;
  deliveryHash?: string;
  fileId?: string;
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
const jobs: Map<number, Job> = loadJobs() as Map<number, Job>;

// File store
interface FileEntry {
  id: string;
  escrowId: number;
  filename: string;
  contentType: string;
  encrypted: boolean;
  hash: string;
  uploadedAt: number;
  uploadedBy: string;
}

const files: Map<string, FileEntry> = new Map();

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
        version: "1.0.0",
        network: "solana-devnet",
        programId: PROGRAM_ID,
        description: "Trustless USDC escrow with AI arbitration for agent-to-agent commerce on Solana",
        flow: [
          "1. Buyer calls create_escrow → locks USDC + buyer collateral in PDA vault",
          "2. Seller calls accept_escrow → locks seller collateral",
          "3. Seller delivers work → calls deliver with content hash",
          "4a. Buyer approves → calls approve, seller receives payment + both collaterals returned",
          "4b. Buyer disputes → calls raise_dispute, then arbitrator panel votes",
          "5. Arbitrator calls arbitrate(BuyerWins/SellerWins) → winner takes pool minus 1% fee",
          "6. If buyer doesn't act within 3 days → anyone can call auto_approve",
        ],
        endpoints: {
          "GET /api/instructions": "This documentation",
          "GET /api/jobs": "List all jobs",
          "POST /api/jobs": "Register a new job (after on-chain create_escrow)",
          "GET /api/jobs/:id": "Get job details",
          "PUT /api/jobs/:id/accept": "Mark job as accepted",
          "PUT /api/jobs/:id/deliver": "Upload delivery + mark delivered",
          "PUT /api/jobs/:id/dispute": "Trigger AI arbitration",
          "POST /api/agents/register": "Register an agent (creates wallet, funds SOL+USDC)",
          "POST /api/escrows/create": "Create escrow on-chain (buyerAgentId, description, paymentAmount, buyerCollateral, sellerCollateral)",
          "POST /api/escrows/accept": "Accept escrow on-chain (sellerAgentId, escrowId)",
          "POST /api/escrows/deliver": "Deliver work on-chain (sellerAgentId, escrowId, contentHash)",
          "POST /api/escrows/approve": "Approve & release on-chain (buyerAgentId, escrowId)",
          "GET /api/escrows": "List all escrows from chain",
          "POST /api/files": "Upload file (optional ECIES encryption with encryptForPubKey)",
          "GET /api/files": "List files (?escrowId= to filter)",
          "GET /api/files/:fileId": "Get file metadata (add ?raw=true for binary download)",
          "GET /api/ecies/keypair": "Generate demo secp256k1 keypair",
          "POST /api/ecies/decrypt": "Server-side decrypt (fileId + privateKey)",
        },
        arbitration: {
          demo: "Grok 4.1 (active in this demo)",
          production: ["Claude Opus 4.6", "GPT 5.2", "Gemini 3 Pro", "Grok 4.1"],
          mechanism: "Demo: single model (Grok 4.1). Production: 3 primary models vote, majority wins. If any primary fails, Grok replaces it. Always odd number of votes.",
          fee: "1% of buyer collateral",
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
        const allJobs = [...onChainJobs, ...memOnlyJobs].sort((a, b) => b.escrowId - a.escrowId);
        return json(res, { jobs: allJobs, count: allJobs.length, source: "chain+memory" });
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
      jobs.set(escrowId, job); saveJobs(jobs);
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

        const result = await arbitrate(
          escrowData,
          body.buyerArgument || "Work was not delivered as described",
          body.sellerArgument || "Work was delivered according to spec",
          body.deliveryContent || (() => {
            // Auto-fetch delivery content from stored files
            const escrowFiles = listFiles(id);
            if (escrowFiles.length > 0) {
              const fileData = downloadFile(escrowFiles[escrowFiles.length - 1].id);
              return fileData?.data?.toString("utf8")?.slice(0, 5000) || "No content provided";
            }
            return "No content provided";
          })(),
          apiKeys
        );

        job.state = result.finalRuling === "BuyerWins" ? "resolved_buyer" : "resolved_seller";

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

        saveJobs(jobs);
        return json(res, { ok: true, job, arbitration: result, onChainTx });
      }

      return json(res, { ok: true, job, arbitration: null, message: "API keys not configured — manual arbitration required" });
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
          const keys = getOrCreateEscrowKeys(String(escrowId));
          
          // Encrypt for buyer
          const buyerResult = uploadFile({
            content, filename, contentType, escrowId, uploadedBy,
            encryptForPubKey: keys.buyerPubKey,
          });
          // Encrypt for arbitrator
          const arbResult = uploadFile({
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
          // Client-specified encryption key
          const result = uploadFile({
            content, filename, contentType, escrowId, uploadedBy, encryptForPubKey,
          });
          return json(res, { ok: true, fileId: result.fileId, contentHash: result.contentHash, meta: result.meta, encryption: "client-ecies" }, 201);
        } else {
          // No escrowId — store unencrypted
          const result = uploadFile({
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
        const result = uploadFile({ content, filename, contentType, escrowId, uploadedBy, encryptForPubKey });
        return json(res, { ok: true, fileId: result.fileId, contentHash: result.contentHash, hash: result.contentHash }, 201);
      } catch (err: any) {
        return json(res, { error: `Upload failed: ${err.message}` }, 500);
      }
    }

    // List files for an escrow
    if (pathname === "/api/files" && req.method === "GET") {
      const escrowId = url.searchParams.get("escrowId");
      const fileList = listFiles(escrowId ? parseInt(escrowId) : undefined);
      return json(res, { files: fileList, count: fileList.length });
    }

    // Decrypt file for buyer (server-managed keys)
    const decryptMatch = pathname.match(/^\/api\/files\/([a-f0-9-]+)\/decrypt$/);
    if (decryptMatch && req.method === "GET") {
      const fileId = decryptMatch[1];
      const escrowId = url.searchParams.get("escrowId");
      const role = url.searchParams.get("role") || "buyer";
      
      if (!escrowId) return json(res, { error: "Missing ?escrowId= parameter" }, 400);
      
      const file = downloadFile(fileId);
      if (!file) return json(res, { error: "File not found" }, 404);
      if (!file.meta.encrypted) {
        // Not encrypted — serve directly
        res.writeHead(200, {
          "Content-Type": file.meta.contentType || "text/plain",
          "Content-Disposition": `inline; filename="${file.meta.filename}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(file.data);
      }
      
      try {
        const { decryptForBuyer, decryptForArbitrator } = await import("./encryption");
        const decrypted = role === "arbitrator"
          ? decryptForArbitrator(escrowId, file.data)
          : decryptForBuyer(escrowId, file.data);
        
        const origFilename = file.meta.filename.replace(/\.arb$/, "");
        res.writeHead(200, {
          "Content-Type": file.meta.contentType || "text/plain",
          "Content-Disposition": `inline; filename="${origFilename}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(decrypted);
      } catch (err: any) {
        return json(res, { error: `Decryption failed: ${err.message}` }, 500);
      }
    }

    // Generate keypair (for demo/testing — DO NOT use in production)
    if (pathname === "/api/ecies/keypair" && req.method === "GET") {
      const kp = generateKeyPair();
      return json(res, kp);
    }

    // Server-side decrypt (for demo — in production, decrypt client-side)
    if (pathname === "/api/ecies/decrypt" && req.method === "POST") {
      const body = await parseBody(req);
      const { fileId, privateKey } = body;
      if (!fileId || !privateKey) {
        return json(res, { error: "Missing fileId or privateKey" }, 400);
      }
      const file = downloadFile(fileId);
      if (!file) return json(res, { error: "File not found" }, 404);
      if (!file.meta.encrypted) {
        return json(res, { error: "File is not encrypted" }, 400);
      }
      try {
        const decrypted = decryptWithPrivateKey(privateKey, file.data);
        return json(res, {
          ok: true,
          content: decrypted.toString("base64"),
          contentType: file.meta.contentType,
          filename: file.meta.filename,
        });
      } catch (err: any) {
        return json(res, { error: `Decryption failed: ${err.message}` }, 400);
      }
    }

    // Download file by ID
    const fileMatch = pathname.match(/^\/api\/files\/([a-f0-9-]+)$/);
    if (fileMatch && req.method === "GET") {
      const fileId = fileMatch[1];
      const raw = url.searchParams.get("raw") === "true";

      if (raw) {
        const file = downloadFile(fileId);
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

      const meta = getFileMeta(fileId);
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

    // === ON-CHAIN AGENT ENDPOINTS ===
    if (pathname === "/api/agents/register" && req.method === "POST") {
      const { initOnChain, registerAgent } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.agentId) return json(res, { error: "Missing agentId" }, 400);
      const result = await registerAgent(body.agentId);
      return json(res, { ok: true, ...result });
    }

    if (pathname === "/api/escrows/create" && req.method === "POST") {
      const { initOnChain, createEscrow } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.buyerAgentId || !body.description) return json(res, { error: "Missing buyerAgentId or description" }, 400);
      const result = await createEscrow(
        body.buyerAgentId,
        body.description,
        body.paymentAmount || 1_000_000,
        body.buyerCollateral || 100_000,
        body.sellerCollateral || 50_000,
      );
      return json(res, { ok: true, ...result });
    }

    if (pathname === "/api/escrows/accept" && req.method === "POST") {
      const { initOnChain, acceptEscrow } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.sellerAgentId || !body.escrowId) return json(res, { error: "Missing sellerAgentId or escrowId" }, 400);
      const result = await acceptEscrow(body.sellerAgentId, body.escrowId);
      return json(res, { ok: true, ...result });
    }

    if (pathname === "/api/escrows/deliver" && req.method === "POST") {
      const { initOnChain, deliverEscrow } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.sellerAgentId || !body.escrowId) return json(res, { error: "Missing sellerAgentId or escrowId" }, 400);
      const result = await deliverEscrow(body.sellerAgentId, body.escrowId, body.contentHash || "delivery");
      return json(res, { ok: true, ...result });
    }

    if (pathname === "/api/escrows/approve" && req.method === "POST") {
      const { initOnChain, approveEscrow } = await import("./onchain");
      await initOnChain();
      const body = await parseBody(req);
      if (!body.buyerAgentId || !body.escrowId) return json(res, { error: "Missing buyerAgentId or escrowId" }, 400);
      const result = await approveEscrow(body.buyerAgentId, body.escrowId);
      return json(res, { ok: true, ...result });
    }

    if (pathname === "/api/escrows" && req.method === "GET") {
      const { initOnChain, listEscrowsOnChain } = await import("./onchain");
      await initOnChain();
      const escrows = await listEscrowsOnChain();
      return json(res, { escrows, count: escrows.length, source: "chain" });
    }

    // === HEALTH ===
    if (pathname === "/health") {
      return json(res, { status: "ok", uptime: process.uptime(), jobs: jobs.size, files: files.size });
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

server.listen(PORT, () => {
  console.log(`🦞 Clawscrow API running on port ${PORT}`);
  console.log(`   Network: Solana Devnet`);
  console.log(`   Program: ${PROGRAM_ID}`);
  console.log(`   Docs: http://localhost:${PORT}/api/instructions`);
});
