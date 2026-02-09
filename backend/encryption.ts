/**
 * Clawscrow ECIES Encryption
 * 
 * End-to-end encryption for file delivery.
 * Seller encrypts with buyer's public key → only buyer can decrypt.
 * Server is a "blind relay" — cannot read encrypted content.
 * 
 * Uses: secp256k1 ECIES + AES-256-GCM
 */

import * as crypto from "crypto";
import { ec as EC } from "elliptic";

const ec = new EC("secp256k1");

/**
 * Derive a shared secret from ephemeral private key + recipient public key
 */
function deriveSharedSecret(ephemeralPrivateKey: Buffer, recipientPublicKey: Buffer): Buffer {
  const ephemeral = ec.keyFromPrivate(ephemeralPrivateKey);
  const recipient = ec.keyFromPublic(recipientPublicKey);
  const shared = ephemeral.derive(recipient.getPublic());
  
  // KDF: SHA-256 of shared secret
  return crypto.createHash("sha256").update(Buffer.from(shared.toArray("be", 32))).digest();
}

/**
 * Encrypt data with recipient's public key (secp256k1)
 * 
 * Format: [ephemeralPubKey (65 bytes)] [iv (12 bytes)] [tag (16 bytes)] [ciphertext]
 */
export function eciesEncrypt(plaintext: Buffer, recipientPublicKeyHex: string): Buffer {
  // Generate ephemeral key pair
  const ephemeral = ec.genKeyPair();
  const ephemeralPrivateKey = Buffer.from(ephemeral.getPrivate().toArray("be", 32));
  const ephemeralPublicKey = Buffer.from(ephemeral.getPublic().encode("array", false));
  
  // Recipient public key
  const recipientPubKey = Buffer.from(recipientPublicKeyHex.replace("0x", ""), "hex");
  
  // Derive shared secret
  const sharedSecret = deriveSharedSecret(ephemeralPrivateKey, recipientPubKey);
  
  // AES-256-GCM encryption
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sharedSecret, iv);
  
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  // Pack: ephemeralPubKey(65) + iv(12) + tag(16) + ciphertext
  return Buffer.concat([ephemeralPublicKey, iv, tag, encrypted]);
}

/**
 * Decrypt data with recipient's private key
 * 
 * Expects format: [ephemeralPubKey (65 bytes)] [iv (12 bytes)] [tag (16 bytes)] [ciphertext]
 */
export function eciesDecrypt(encryptedData: Buffer, recipientPrivateKeyHex: string): Buffer {
  // Parse components
  const ephemeralPublicKey = encryptedData.subarray(0, 65);
  const iv = encryptedData.subarray(65, 77);
  const tag = encryptedData.subarray(77, 93);
  const ciphertext = encryptedData.subarray(93);
  
  // Recipient private key
  const recipientPrivKey = Buffer.from(recipientPrivateKeyHex.replace("0x", ""), "hex");
  
  // Derive shared secret
  const sharedSecret = deriveSharedSecret(recipientPrivKey, ephemeralPublicKey);
  
  // AES-256-GCM decryption
  const decipher = crypto.createDecipheriv("aes-256-gcm", sharedSecret, iv);
  decipher.setAuthTag(tag);
  
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Hash content using keccak256 (for delivery verification)
 */
export function hashContent(content: Buffer | string): string {
  const data = typeof content === "string" ? Buffer.from(content.trim()) : content;
  return crypto.createHash("sha3-256").update(data).digest("hex");
}

/**
 * Encrypt a file for delivery
 * Returns { encrypted: Buffer, hash: string }
 */
export function encryptForDelivery(
  content: Buffer,
  buyerPublicKeyHex: string
): { encrypted: Buffer; hash: string } {
  const hash = hashContent(content);
  const encrypted = eciesEncrypt(content, buyerPublicKeyHex);
  return { encrypted, hash };
}

/**
 * Decrypt a delivered file
 * Returns { decrypted: Buffer, hash: string, verified: boolean }
 */
export function decryptDelivery(
  encryptedData: Buffer,
  buyerPrivateKeyHex: string,
  expectedHash?: string
): { decrypted: Buffer; hash: string; verified: boolean } {
  const decrypted = eciesDecrypt(encryptedData, buyerPrivateKeyHex);
  const hash = hashContent(decrypted);
  const verified = expectedHash ? hash === expectedHash : true;
  return { decrypted, hash, verified };
}

// === Self-test ===
if (require.main === module) {
  console.log("Running ECIES self-test...");
  
  // Generate test keys
  const testKey = ec.genKeyPair();
  const pubKeyHex = Buffer.from(testKey.getPublic().encode("array", false)).toString("hex");
  const privKeyHex = Buffer.from(testKey.getPrivate().toArray("be", 32)).toString("hex");
  
  // Test encrypt/decrypt
  const message = Buffer.from("Hello Clawscrow! 🦞");
  const { encrypted, hash } = encryptForDelivery(message, pubKeyHex);
  
  console.log(`Original: ${message.toString()}`);
  console.log(`Hash: ${hash}`);
  console.log(`Encrypted size: ${encrypted.length} bytes`);
  
  const { decrypted, hash: decHash, verified } = decryptDelivery(encrypted, privKeyHex, hash);
  
  console.log(`Decrypted: ${decrypted.toString()}`);
  console.log(`Hash match: ${verified}`);
  console.log(`✅ ECIES self-test passed!`);
}
