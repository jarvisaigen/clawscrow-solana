/**
 * Clawscrow Storage Layer
 * 
 * S3-compatible storage via Railway Buckets (or local filesystem fallback).
 * All file/metadata/key/ruling operations go through this module.
 * 
 * Environment variables (auto-set by Railway bucket linkage):
 *   AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID,
 *   AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";

// Detect S3 config from environment
const S3_ENDPOINT = process.env.AWS_ENDPOINT_URL;
const S3_BUCKET = process.env.AWS_S3_BUCKET_NAME;
const S3_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const S3_SECRET = process.env.AWS_SECRET_ACCESS_KEY;
const S3_REGION = process.env.AWS_DEFAULT_REGION || "auto";

const USE_S3 = !!(S3_ENDPOINT && S3_BUCKET && S3_KEY_ID && S3_SECRET);

let s3: S3Client | null = null;
if (USE_S3) {
  s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_KEY_ID!,
      secretAccessKey: S3_SECRET!,
    },
    forcePathStyle: false, // Railway uses virtual-hosted style
  });
  console.log(`[Storage] Using S3 bucket: ${S3_BUCKET} @ ${S3_ENDPOINT}`);
} else {
  console.log(`[Storage] S3 not configured — using local filesystem fallback`);
}

// Local fallback directory
const LOCAL_DATA = process.env.DATA_DIR || path.join(__dirname, "../data");

// === Core operations ===

export async function put(key: string, data: Buffer | string): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;

  if (s3) {
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: key,
      Body: buf,
    }));
  } else {
    const filePath = path.join(LOCAL_DATA, key);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buf);
  }
}

export async function get(key: string): Promise<Buffer | null> {
  if (s3) {
    try {
      const resp = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET!,
        Key: key,
      }));
      const stream = resp.Body;
      if (!stream) return null;
      // Collect stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (e: any) {
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  } else {
    const filePath = path.join(LOCAL_DATA, key);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }
}

export async function del(key: string): Promise<void> {
  if (s3) {
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET!,
        Key: key,
      }));
    } catch {}
  } else {
    const filePath = path.join(LOCAL_DATA, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

export async function list(prefix: string): Promise<string[]> {
  if (s3) {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents || []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  } else {
    const dir = path.join(LOCAL_DATA, prefix);
    if (!fs.existsSync(dir)) return [];
    // For local fs, prefix is treated as directory
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        return fs.readdirSync(dir).map(f => `${prefix}/${f}`);
      }
    } catch {}
    return [];
  }
}

// === Convenience: JSON storage ===

export async function putJSON(key: string, data: any): Promise<void> {
  await put(key, JSON.stringify(data, null, 2));
}

export async function getJSON<T = any>(key: string): Promise<T | null> {
  const buf = await get(key);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

// Export config info
export const storageInfo = {
  useS3: USE_S3,
  bucket: S3_BUCKET || null,
  endpoint: S3_ENDPOINT || null,
};
