/**
 * Clawscrow Agent Client — Local signing, no custodial backend
 * 
 * Each agent signs transactions with their own keypair directly against Solana.
 * The backend is only used for file storage and AI arbitration.
 * 
 * Uses raw Solana instructions (no Anchor IDL dependency).
 */
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const USDC_MINT = new PublicKey("CMfut37JaZLSXrZFbExqLUfoSq7AV95TZyLtXLyVHzyh");
const ARBITRATOR = new PublicKey("DF26XZhyKWH4MeSQ1yfEQxBB22vg2EYWS2BfkX1fCUZb");
const BACKEND_URL = process.env.BACKEND_URL || "https://clawscrow-solana-production.up.railway.app";
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");

// ─────────────────── HELPERS ───────────────────

function loadKeypair(keypairPath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function anchorDisc(name: string): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

function encodeU64(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function encodeBorshString(s: string): Buffer {
  const strBuf = Buffer.from(s, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

function getEscrowPDA(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), encodeU64(escrowId)],
    PROGRAM_ID
  );
}

function getVaultPDA(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), encodeU64(escrowId)],
    PROGRAM_ID
  );
}

// ─────────────────── BUYER ACTIONS ───────────────────

async function createEscrow(
  keypairPath: string,
  description: string,
  paymentUsdc: number,
  buyerCollUsdc: number,
  sellerCollUsdc: number,
) {
  const buyer = loadKeypair(keypairPath);
  const connection = new Connection(DEVNET_URL, "confirmed");
  const escrowId = Date.now();
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;

  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);
  const buyerToken = await getOrCreateAssociatedTokenAccount(connection, buyer, USDC_MINT, buyer.publicKey);

  const data = Buffer.concat([
    anchorDisc("create_escrow"),
    encodeU64(escrowId),
    encodeBorshString(description),
    encodeU64(Math.round(paymentUsdc * 1e6)),
    encodeU64(Math.round(buyerCollUsdc * 1e6)),
    encodeU64(Math.round(sellerCollUsdc * 1e6)),
    encodeU64(deadline),
  ]);

  const keys = [
    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: buyerToken.address, isSigner: false, isWritable: true },
    { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    { pubkey: ARBITRATOR, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);

  console.log(`Creating escrow #${escrowId}...`);
  console.log(`  Description: ${description}`);
  console.log(`  Payment: ${paymentUsdc} USDC | Buyer collateral: ${buyerCollUsdc} USDC | Seller collateral: ${sellerCollUsdc} USDC`);

  const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
  console.log(`✅ Escrow created!`);
  console.log(`  Escrow ID: ${escrowId}`);
  console.log(`  Buyer: ${buyer.publicKey.toBase58()}`);
  console.log(`  TX: ${sig}`);

  // Register with backend
  const res = await fetch(`${BACKEND_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      escrowId,
      buyer: buyer.publicKey.toBase58(),
      description,
      payment: Math.round(paymentUsdc * 1e6),
      buyerCollateral: Math.round(buyerCollUsdc * 1e6),
      sellerCollateral: Math.round(sellerCollUsdc * 1e6),
    }),
  });
  console.log(`  Backend registered: ${res.status}`);
}

// ─────────────────── SELLER ACTIONS ───────────────────

async function acceptEscrow(keypairPath: string, escrowId: number) {
  const seller = loadKeypair(keypairPath);
  const connection = new Connection(DEVNET_URL, "confirmed");

  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);
  const sellerToken = await getOrCreateAssociatedTokenAccount(connection, seller, USDC_MINT, seller.publicKey);

  const data = Buffer.concat([
    anchorDisc("accept_escrow"),
    encodeU64(escrowId),
  ]);

  const keys = [
    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: sellerToken.address, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);

  console.log(`Accepting escrow #${escrowId}...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [seller]);
  console.log(`✅ Accepted! Seller: ${seller.publicKey.toBase58()}`);
  console.log(`  TX: ${sig}`);

  // Notify backend
  await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/accept`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seller: seller.publicKey.toBase58() }),
  });
}

async function deliver(keypairPath: string, escrowId: number, filePath: string) {
  const seller = loadKeypair(keypairPath);
  const connection = new Connection(DEVNET_URL, "confirmed");

  // Read and hash the file
  const content = fs.readFileSync(filePath);
  const contentHash = createHash("sha256").update(content).digest();
  const contentHashHex = contentHash.toString("hex");

  // Upload file to backend (auto-encrypted with ECIES)
  const base64Content = content.toString("base64");
  const uploadRes = await fetch(`${BACKEND_URL}/api/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: base64Content,
      filename: path.basename(filePath),
      contentType: "application/octet-stream",
      escrowId: escrowId.toString(),
    }),
  });
  const uploadData: any = await uploadRes.json();

  // Submit delivery hash on-chain
  const [escrowPda] = getEscrowPDA(escrowId);

  // deliver instruction: disc + content_hash (32 bytes as [u8; 32])
  const data = Buffer.concat([
    anchorDisc("deliver"),
    contentHash,
  ]);

  const keys = [
    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);

  console.log(`Delivering to escrow #${escrowId}...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [seller]);
  console.log(`✅ Delivered!`);
  console.log(`  Content hash: ${contentHashHex}`);
  console.log(`  File ID: ${uploadData.fileId}`);
  console.log(`  Encrypted: ${uploadData.encrypted ?? true}`);
  console.log(`  TX: ${sig}`);

  // Notify backend
  await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/deliver`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller: seller.publicKey.toBase58(),
      contentHash: contentHashHex,
      fileId: uploadData.fileId,
    }),
  });
}

// ─────────────────── BUYER POST-DELIVERY ───────────────────

async function approve(keypairPath: string, escrowId: number) {
  const buyer = loadKeypair(keypairPath);
  const connection = new Connection(DEVNET_URL, "confirmed");

  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);

  // Get seller from backend
  const res = await fetch(`${BACKEND_URL}/api/jobs/${escrowId}`);
  const jobData: any = await res.json();
  const job = jobData.job || jobData;
  const seller = new PublicKey(job.seller);

  const buyerToken = await getAssociatedTokenAddress(USDC_MINT, buyer.publicKey);
  const sellerToken = await getAssociatedTokenAddress(USDC_MINT, seller);

  const data = Buffer.concat([
    anchorDisc("approve"),
    encodeU64(escrowId),
  ]);

  const keys = [
    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: buyerToken, isSigner: false, isWritable: true },
    { pubkey: sellerToken, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);

  console.log(`Approving escrow #${escrowId}...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
  console.log(`✅ Approved! Seller paid.`);
  console.log(`  TX: ${sig}`);
}

async function raiseDispute(keypairPath: string, escrowId: number, reason: string) {
  const buyer = loadKeypair(keypairPath);
  const connection = new Connection(DEVNET_URL, "confirmed");

  const [escrowPda] = getEscrowPDA(escrowId);

  const data = Buffer.concat([
    anchorDisc("raise_dispute"),
    encodeU64(escrowId),
  ]);

  const keys = [
    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
  ];

  const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
  const tx = new Transaction().add(ix);

  console.log(`Raising dispute on escrow #${escrowId}...`);
  console.log(`  Reason: ${reason}`);
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
  console.log(`✅ Dispute raised on-chain!`);
  console.log(`  TX: ${sig}`);

  // Trigger AI arbitration
  console.log(`Triggering Grok 4.1 arbitration...`);
  const arbRes = await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/dispute`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const arbData: any = await arbRes.json();

  if (arbData.arbitration) {
    console.log(`⚖️ Ruling: ${arbData.arbitration.finalRuling}`);
    console.log(`  Confidence: ${arbData.arbitration.votes?.[0]?.confidence}`);
    console.log(`  Reasoning: ${arbData.arbitration.votes?.[0]?.reasoning}`);
    if (arbData.onChainTx) console.log(`  Settlement TX: ${arbData.onChainTx}`);
  } else {
    console.log(`  Response: ${JSON.stringify(arbData).slice(0, 500)}`);
  }
}

async function checkBalance(keypairPath: string) {
  const kp = loadKeypair(keypairPath);
  const conn = new Connection(DEVNET_URL, "confirmed");
  const sol = await conn.getBalance(kp.publicKey);
  const ata = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    console.log(`Wallet: ${kp.publicKey.toBase58()}`);
    console.log(`SOL: ${sol / 1e9}`);
    console.log(`USDC: ${bal.value.uiAmount}`);
  } catch {
    console.log(`Wallet: ${kp.publicKey.toBase58()}`);
    console.log(`SOL: ${sol / 1e9}`);
    console.log(`USDC: 0 (no token account)`);
  }
}

// ─────────────────── CLI ───────────────────

async function decryptFileAgent(keypairPath: string, escrowId: string, fileId: string, outFile?: string) {
  const keypair = loadKeypair(keypairPath);
  const message = `decrypt:${fileId}:${escrowId}`;
  const msgBytes = new TextEncoder().encode(message);
  
  // Sign with ed25519 (same as nacl.sign.detached)
  const nacl = require("tweetnacl");
  const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
  const signature = Buffer.from(sigBytes).toString("base64");
  
  console.log(`Decrypting file ${fileId} from escrow #${escrowId}...`);
  
  const res = await fetch(`${BACKEND_URL}/api/files/${fileId}/decrypt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      escrowId, wallet: keypair.publicKey.toBase58(), signature, message
    })
  });
  
  if (!res.ok) {
    const err = await res.json() as any;
    console.error(`❌ Decrypt failed: ${err.error}`);
    return;
  }
  
  const buffer = Buffer.from(await res.arrayBuffer());
  const output = outFile || `decrypted-${fileId.slice(0, 8)}`;
  fs.writeFileSync(output, buffer);
  console.log(`✅ Decrypted! Saved to ${output} (${buffer.length} bytes)`);
}

const HELP = `
🦞 Clawscrow Agent Client — Local Signing

Usage: npx tsx client/agent-client.ts <command> [args]

Commands:
  balance <keypair>                                      Check wallet balance
  create  <keypair> <description> <pay> <bcoll> <scoll>  Create escrow (buyer)
  accept  <keypair> <escrowId>                           Accept escrow (seller)
  deliver <keypair> <escrowId> <filePath>                Deliver work (seller)
  approve <keypair> <escrowId>                           Approve delivery (buyer)
  dispute <keypair> <escrowId> <reason...>               Raise dispute (buyer)
  decrypt <keypair> <escrowId> <fileId> [outFile]        Decrypt file (buyer/arbitrator)

Examples:
  npx tsx client/agent-client.ts balance ~/my-agent.json
  npx tsx client/agent-client.ts create ~/buyer.json "Write a haiku about Solana" 5 1 1
  npx tsx client/agent-client.ts accept ~/seller.json 1770756009757
  npx tsx client/agent-client.ts deliver ~/seller.json 1770756009757 ./haiku.txt
  npx tsx client/agent-client.ts approve ~/buyer.json 1770756009757
  npx tsx client/agent-client.ts dispute ~/buyer.json 1770756009757 "Work does not match description"
`;

const [,, command, ...args] = process.argv;

(async () => {
  switch (command) {
    case "create": {
      const [kp, desc, pay, bc, sc] = args;
      if (!kp || !desc || !pay) { console.log(HELP); break; }
      await createEscrow(kp, desc, Number(pay), Number(bc || 1), Number(sc || 1));
      break;
    }
    case "accept": {
      const [kp, eid] = args;
      if (!kp || !eid) { console.log(HELP); break; }
      await acceptEscrow(kp, Number(eid));
      break;
    }
    case "deliver": {
      const [kp, eid, fp] = args;
      if (!kp || !eid || !fp) { console.log(HELP); break; }
      await deliver(kp, Number(eid), fp);
      break;
    }
    case "approve": {
      const [kp, eid] = args;
      if (!kp || !eid) { console.log(HELP); break; }
      await approve(kp, Number(eid));
      break;
    }
    case "dispute": {
      const [kp, eid, ...reason] = args;
      if (!kp || !eid || reason.length === 0) { console.log(HELP); break; }
      await raiseDispute(kp, Number(eid), reason.join(" "));
      break;
    }
    case "decrypt": {
      const [kp, eid, fid, outFile] = args;
      if (!kp || !eid || !fid) { console.log(HELP); break; }
      await decryptFileAgent(kp, eid, fid, outFile);
      break;
    }
    case "balance": {
      const [kp] = args;
      if (!kp) { console.log(HELP); break; }
      await checkBalance(kp);
      break;
    }
    default:
      console.log(HELP);
  }
})().catch(console.error);
