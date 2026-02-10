/**
 * Clawscrow File Upload/Download Service
 * 
 * Handles encrypted file delivery for escrow marketplace.
 * Files stored in S3 bucket (or local fallback) with SHA-256 content hashes.
 */

import * as crypto from "crypto";
import { encryptForRecipient, decryptWithPrivateKey } from "./ecies";
import * as storage from "./storage";

export interface FileMeta {
  id: string;
  escrowId?: number;
  filename: string;
  contentType: string;
  contentHash: string;
  encryptedHash?: string;
  encrypted: boolean;
  recipientPubKey?: string;
  uploadedBy: string;
  uploadedAt: number;
  size: number;
}

/**
 * Upload a file. Optionally encrypts with recipient's public key.
 */
export async function uploadFile(params: {
  content: string;
  encoding?: "base64" | "utf8";
  filename?: string;
  contentType?: string;
  escrowId?: number;
  uploadedBy?: string;
  encryptForPubKey?: string;
}): Promise<{ fileId: string; contentHash: string; meta: FileMeta }> {
  // Auto-detect encoding
  let raw: Buffer;
  if (params.encoding === "base64") {
    raw = Buffer.from(params.content, "base64");
  } else if (params.encoding === "utf8") {
    raw = Buffer.from(params.content, "utf8");
  } else {
    const b64decoded = Buffer.from(params.content, "base64");
    const roundTrip = b64decoded.toString("base64");
    if (roundTrip === params.content && /^[A-Za-z0-9+/=]+$/.test(params.content)) {
      raw = b64decoded;
    } else {
      raw = Buffer.from(params.content, "utf8");
    }
  }

  const contentHash = crypto.createHash("sha256").update(raw).digest("hex");

  let stored: Buffer;
  let encrypted = false;
  if (params.encryptForPubKey) {
    stored = encryptForRecipient(params.encryptForPubKey, raw);
    encrypted = true;
  } else {
    stored = raw;
  }

  const encryptedHash = crypto.createHash("sha256").update(stored).digest("hex");
  const fileId = crypto.randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

  // Write file + metadata to storage
  await storage.put(`files/${fileId}`, stored);

  const meta: FileMeta = {
    id: fileId,
    escrowId: params.escrowId,
    filename: params.filename || "delivery",
    contentType: params.contentType || "application/octet-stream",
    contentHash,
    encryptedHash,
    encrypted,
    recipientPubKey: params.encryptForPubKey,
    uploadedBy: params.uploadedBy || "unknown",
    uploadedAt: Date.now(),
    size: raw.length,
  };
  await storage.putJSON(`meta/${fileId}.json`, meta);

  return { fileId, contentHash, meta };
}

/**
 * Get file metadata by ID.
 */
export async function getFileMeta(fileId: string): Promise<FileMeta | null> {
  return storage.getJSON<FileMeta>(`meta/${fileId}.json`);
}

/**
 * Download file content (raw bytes as stored — may be encrypted).
 */
export async function downloadFile(fileId: string): Promise<{ data: Buffer; meta: FileMeta } | null> {
  const meta = await getFileMeta(fileId);
  if (!meta) return null;

  const data = await storage.get(`files/${fileId}`);
  if (!data) return null;

  return { data, meta };
}

/**
 * List all files, optionally filtered by escrowId.
 */
export async function listFiles(escrowId?: number): Promise<FileMeta[]> {
  const keys = await storage.list("meta");
  const all: FileMeta[] = [];
  
  for (const key of keys) {
    if (!key.endsWith(".json")) continue;
    const meta = await storage.getJSON<FileMeta>(key);
    if (meta) all.push(meta);
  }

  if (escrowId !== undefined) {
    return all.filter((f) => String(f.escrowId) === String(escrowId));
  }
  return all;
}

/**
 * Delete all files for an escrow (privacy cleanup after resolve)
 */
export async function deleteFilesForEscrow(escrowId: number): Promise<number> {
  const files = await listFiles(escrowId);
  let deleted = 0;
  for (const meta of files) {
    try {
      await storage.del(`files/${meta.id}`);
      await storage.del(`meta/${meta.id}.json`);
      deleted++;
    } catch {}
  }
  // Also delete ECIES keys for this escrow
  await storage.del(`keys/${escrowId}.json`);
  
  console.log(`[Cleanup] Deleted ${deleted} files + keys for escrow #${escrowId}`);
  return deleted;
}
