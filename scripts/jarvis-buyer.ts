/**
 * Jarvis Buyer — creates escrow on-chain using raw instructions
 * Bypasses Anchor IDL Ruling type bug
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
import { createHash } from "crypto";

const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const USDC_MINT = new PublicKey("CMfut37JaZLSXrZFbExqLUfoSq7AV95TZyLtXLyVHzyh");
const ARBITRATOR = new PublicKey("DF26XZhyKWH4MeSQ1yfEQxBB22vg2EYWS2BfkX1fCUZb");

function anchorDisc(name: string): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

function encodeU64(n: number): Buffer {
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

async function main() {
  const [action, ...args] = process.argv.slice(2);
  
  const keypairPath = "./jarvis-test-keypair.json";
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const buyer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const connection = new Connection(DEVNET_URL, "confirmed");

  console.log(`Buyer: ${buyer.publicKey.toBase58()}`);

  if (action === "create") {
    const [description, payment, buyerCol, sellerCol, sellerAddr] = args;
    const paymentAmount = parseFloat(payment) * 1e6;
    const buyerCollateral = parseFloat(buyerCol) * 1e6;
    const sellerCollateral = parseFloat(sellerCol) * 1e6;
    const seller = new PublicKey(sellerAddr || "F4jg6iRxDbjSP5Q86V6gxMyDyQArEakEcGR9fSs64WfK"); // Ash default
    const escrowId = Date.now();
    const deadline = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days

    // PDAs
    const escrowIdBuf = Buffer.alloc(8);
    escrowIdBuf.writeBigUInt64LE(BigInt(escrowId));
    
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowIdBuf], PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowIdBuf], PROGRAM_ID
    );

    const buyerToken = await getOrCreateAssociatedTokenAccount(
      connection, buyer, USDC_MINT, buyer.publicKey
    );

    // Instruction data: disc + escrow_id + description + payment + buyer_col + seller_col + deadline
    const disc = anchorDisc("create_escrow");
    const data = Buffer.concat([
      disc,
      encodeU64(escrowId),
      encodeBorshString(description),
      encodeU64(paymentAmount),
      encodeU64(buyerCollateral),
      encodeU64(sellerCollateral),
      encodeU64(deadline),
    ]);

    const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
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
    console.log(`  Payment: ${payment} USDC`);
    console.log(`  Seller: ${seller.toBase58()}`);
    
    const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
    console.log(`✅ Escrow created!`);
    console.log(`  TX: ${sig}`);
    console.log(`  Escrow PDA: ${escrowPda.toBase58()}`);
    console.log(`  Escrow ID: ${escrowId}`);
    
  } else if (action === "approve") {
    const [escrowIdStr] = args;
    const escrowId = parseInt(escrowIdStr);
    const escrowIdBuf = Buffer.alloc(8);
    escrowIdBuf.writeBigUInt64LE(BigInt(escrowId));

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowIdBuf], PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowIdBuf], PROGRAM_ID
    );

    // Need seller address to find their ATA — get from API
    const res = await fetch(`https://clawscrow-solana-production.up.railway.app/api/jobs/${escrowId}`);
    const jobData = await res.json();
    const job = jobData.job || jobData;
    const seller = new PublicKey(job.seller);

    const buyerToken = await getAssociatedTokenAddress(USDC_MINT, buyer.publicKey);
    const sellerToken = await getAssociatedTokenAddress(USDC_MINT, seller);

    const disc = anchorDisc("approve");
    const data = Buffer.concat([disc, encodeU64(escrowId)]);

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
    console.log(`✅ Approved! TX: ${sig}`);

  } else {
    console.log("Usage:");
    console.log("  npx tsx scripts/jarvis-buyer.ts create <description> <payment> <buyerCol> <sellerCol> [sellerAddr]");
    console.log("  npx tsx scripts/jarvis-buyer.ts approve <escrowId>");
  }
}

main().catch(console.error);
