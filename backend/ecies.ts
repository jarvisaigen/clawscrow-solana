/**
 * ECIES Encryption Module for Clawscrow
 * 
 * Encrypt/decrypt file content using secp256k1 ECIES.
 * Compatible with standard Ethereum/Solana key formats.
 */

import { encrypt, decrypt, PrivateKey } from "eciesjs";

/**
 * Encrypt plaintext for a recipient's public key.
 * @param recipientPubKeyHex - Recipient's secp256k1 public key (hex, compressed or uncompressed)
 * @param plaintext - Data to encrypt
 * @returns Encrypted buffer
 */
export function encryptForRecipient(recipientPubKeyHex: string, plaintext: Buffer): Buffer {
  return Buffer.from(encrypt(recipientPubKeyHex, plaintext));
}

/**
 * Decrypt ciphertext with a private key.
 * @param privateKeyHex - Recipient's secp256k1 private key (hex, 32 bytes)
 * @param ciphertext - Encrypted data from encryptForRecipient
 * @returns Decrypted plaintext buffer
 */
export function decryptWithPrivateKey(privateKeyHex: string, ciphertext: Buffer): Buffer {
  return Buffer.from(decrypt(privateKeyHex, ciphertext));
}

/**
 * Generate a new secp256k1 keypair for testing/demo.
 * @returns { privateKey, publicKey } both as hex strings
 */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const sk = new PrivateKey();
  return {
    privateKey: sk.secret.toString("hex"),
    publicKey: sk.publicKey.toHex(),
  };
}
