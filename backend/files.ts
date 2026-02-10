/**
 * Clawscrow File Upload/Download Service
 * 
 * Handles encrypted file delivery for escrow marketplace.
 * Files stored locally with SHA-256 content hashes for on-chain verification.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { encryptForRecipient, decryptWithPrivateKey } from "./ecies";

const DATA_DIR = path.join(__dirname, "../data");
const META_DIR = path.join(DATA_DIR, "meta");

// Ensure directories exist
[DATA_DIR, META_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

export interface FileMeta {
  id: string;
  escrowId?: number;
  filename: string;
  contentType: string;
  contentHash: string;       // SHA-256 of original plaintext
  encryptedHash?: string;    // SHA-256 of stored (possibly encrypted) content
  encrypted: boolean;
  recipientPubKey?: string;  // If encrypted, the recipient's public key
  uploadedBy: string;
  uploadedAt: number;
  size: number;
}

/**
 * Upload a file. Optionally encrypts with recipient's public key.
 */
export function uploadFile(params: {
  content: string;           // base64-encoded file content
  filename?: string;
  contentType?: string;
  escrowId?: number;
  uploadedBy?: string;
  encryptForPubKey?: string; // If provided, ECIES-encrypt for this public key
}): { fileId: string; contentHash: string; meta: FileMeta } {
  const raw = Buffer.from(params.content, "base64");

  // Hash original plaintext for on-chain verification
  const contentHash = crypto.createHash("sha256").update(raw).digest("hex");

  // Optionally encrypt
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

  // Write file
  fs.writeFileSync(path.join(DATA_DIR, fileId), stored);

  // Write metadata
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
  fs.writeFileSync(path.join(META_DIR, `${fileId}.json`), JSON.stringify(meta, null, 2));

  return { fileId, contentHash, meta };
}

/**
 * Get file metadata by ID.
 */
export function getFileMeta(fileId: string): FileMeta | null {
  const metaPath = path.join(META_DIR, `${fileId}.json`);
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
}

/**
 * Download file content (raw bytes as stored — may be encrypted).
 */
export function downloadFile(fileId: string): { data: Buffer; meta: FileMeta } | null {
  const meta = getFileMeta(fileId);
  if (!meta) return null;

  const filePath = path.join(DATA_DIR, fileId);
  if (!fs.existsSync(filePath)) return null;

  return { data: fs.readFileSync(filePath), meta };
}

/**
 * List all files, optionally filtered by escrowId.
 */
export function listFiles(escrowId?: number): FileMeta[] {
  if (!fs.existsSync(META_DIR)) return [];
  
  const metaFiles = fs.readdirSync(META_DIR).filter((f) => f.endsWith(".json"));
  const all = metaFiles.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(META_DIR, f), "utf-8")) as FileMeta;
    } catch {
      return null;
    }
  }).filter(Boolean) as FileMeta[];

  if (escrowId !== undefined) {
    return all.filter((f) => String(f.escrowId) === String(escrowId));
  }
  return all;
}
