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
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PORT = process.env.PORT || 3051;
const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7";
const UPLOAD_DIR = path.join(__dirname, "../uploads");

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory job store (backed by on-chain escrows)
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
}

const jobs: Map<number, Job> = new Map();

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

async function syncEscrowFromChain(connection: Connection, escrowId: number): Promise<Job | null> {
  try {
    const programId = new PublicKey(PROGRAM_ID);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowId).toArrayLike(Buffer, "le", 8)],
      programId
    );
    
    const accountInfo = await connection.getAccountInfo(escrowPda);
    if (!accountInfo) return null;
    
    // For now, return cached job if exists
    return jobs.get(escrowId) || null;
  } catch {
    return null;
  }
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
          "GET /api/files/:fileId": "Download delivered file",
          "POST /api/files/upload": "Upload encrypted file",
        },
        arbitration: {
          models: ["Claude Opus 4.6", "GPT 5.2", "Gemini 3 Pro"],
          fallback: "Grok 4.1",
          mechanism: "3 primary models vote, majority wins. If any primary fails, Grok replaces it. Always odd number of votes.",
          fee: "1% of buyer collateral",
        },
      });
    }

    // === JOBS ===
    if (pathname === "/api/jobs" && req.method === "GET") {
      const jobList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
      return json(res, { jobs: jobList, count: jobList.length });
    }

    if (pathname === "/api/jobs" && req.method === "POST") {
      const body = await parseBody(req);
      const { escrowId, description, buyer, paymentAmount, buyerCollateral, sellerCollateral } = body;
      
      if (!escrowId || !description || !buyer) {
        return json(res, { error: "Missing required fields: escrowId, description, buyer" }, 400);
      }

      const job: Job = {
        escrowId,
        description,
        buyer,
        paymentAmount: paymentAmount || 0,
        buyerCollateral: buyerCollateral || 0,
        sellerCollateral: sellerCollateral || 0,
        state: "created",
        createdAt: Date.now(),
      };
      jobs.set(escrowId, job);
      return json(res, { ok: true, job }, 201);
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
    if (jobMatch && req.method === "GET") {
      const id = parseInt(jobMatch[1]);
      const job = jobs.get(id);
      if (!job) return json(res, { error: "Job not found" }, 404);
      return json(res, { job });
    }

    const acceptMatch = pathname.match(/^\/api\/jobs\/(\d+)\/accept$/);
    if (acceptMatch && req.method === "PUT") {
      const id = parseInt(acceptMatch[1]);
      const job = jobs.get(id);
      if (!job) return json(res, { error: "Job not found" }, 404);
      
      const body = await parseBody(req);
      job.seller = body.worker || body.seller;
      job.state = "accepted";
      return json(res, { ok: true, job });
    }

    const deliverMatch = pathname.match(/^\/api\/jobs\/(\d+)\/deliver$/);
    if (deliverMatch && req.method === "PUT") {
      const id = parseInt(deliverMatch[1]);
      const job = jobs.get(id);
      if (!job) return json(res, { error: "Job not found" }, 404);
      
      const body = await parseBody(req);
      job.deliveryHash = body.hash;
      job.fileId = body.fileId;
      job.state = "delivered";
      return json(res, { ok: true, job });
    }

    const disputeMatch = pathname.match(/^\/api\/jobs\/(\d+)\/dispute$/);
    if (disputeMatch && req.method === "PUT") {
      const id = parseInt(disputeMatch[1]);
      const job = jobs.get(id);
      if (!job) return json(res, { error: "Job not found" }, 404);
      
      const body = await parseBody(req);
      job.state = "disputed";

      // Trigger AI arbitration if API keys are available
      const apiKeys = {
        anthropic: process.env.ANTHROPIC_API_KEY || "",
        openai: process.env.OPENAI_API_KEY || "",
        gemini: process.env.GEMINI_API_KEY || "",
        grok: process.env.GROK_API_KEY || "",
      };

      if (apiKeys.anthropic && apiKeys.openai && apiKeys.gemini) {
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
          body.deliveryContent || "No content provided",
          apiKeys
        );

        job.state = result.finalRuling === "BuyerWins" ? "resolved_buyer" : "resolved_seller";
        return json(res, { ok: true, job, arbitration: result });
      }

      return json(res, { ok: true, job, arbitration: null, message: "API keys not configured — manual arbitration required" });
    }

    // === FILES ===
    if (pathname === "/api/files/upload" && req.method === "POST") {
      const body = await parseBody(req);
      const { escrowId, filename, content, contentType, encrypted, uploadedBy } = body;

      const hash = crypto.createHash("sha256").update(content || "").digest("hex");
      const fileId = crypto.randomUUID();

      // Save file
      const filePath = path.join(UPLOAD_DIR, fileId);
      fs.writeFileSync(filePath, Buffer.from(content || "", "base64"));

      const entry: FileEntry = {
        id: fileId,
        escrowId,
        filename: filename || "delivery",
        contentType: contentType || "application/octet-stream",
        encrypted: encrypted || false,
        hash,
        uploadedAt: Date.now(),
        uploadedBy: uploadedBy || "unknown",
      };
      files.set(fileId, entry);

      return json(res, { ok: true, fileId, hash }, 201);
    }

    const fileMatch = pathname.match(/^\/api\/files\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const fileId = fileMatch[1];
      const entry = files.get(fileId);
      if (!entry) return json(res, { error: "File not found" }, 404);

      const raw = url.searchParams.get("raw") === "true";
      if (raw) {
        const filePath = path.join(UPLOAD_DIR, fileId);
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": entry.contentType,
          "Content-Disposition": `attachment; filename="${entry.filename}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(data);
      }

      return json(res, { file: entry });
    }

    // === HEALTH ===
    if (pathname === "/health") {
      return json(res, { status: "ok", uptime: process.uptime(), jobs: jobs.size, files: files.size });
    }

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
