/**
 * Ash Buyer — creates escrow on-chain using raw instructions
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
const BACKEND_URL = "https://clawscrow-solana-production.up.railway.app";

const KEYPAIR_PATH = process.env.KEYPAIR || `${process.env.HOME}/.config/solana/ash-agent.json`;

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
  
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const buyer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const connection = new Connection(DEVNET_URL, "confirmed");

  console.log(`Buyer (Ash): ${buyer.publicKey.toBase58()}`);

  if (action === "create") {
    const [description, payment, buyerCol, sellerCol, sellerAddr] = args;
    const paymentAmount = parseFloat(payment) * 1e6;
    const buyerCollateral = parseFloat(buyerCol) * 1e6;
    const sellerCollateral = parseFloat(sellerCol) * 1e6;
    const escrowId = Date.now();
    const deadline = Math.floor(Date.now() / 1000) + 86400 * 7;

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
    console.log(`  Buyer collateral: ${buyerCol} USDC`);
    console.log(`  Seller collateral: ${sellerCol} USDC`);
    
    const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
    console.log(`✅ Escrow created!`);
    console.log(`  TX: ${sig}`);
    console.log(`  Escrow ID: ${escrowId}`);

    // Register with backend
    const regRes = await fetch(`${BACKEND_URL}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        escrowId,
        buyer: buyer.publicKey.toBase58(),
        description,
        payment: paymentAmount,
        buyerCollateral,
        sellerCollateral,
      }),
    });
    console.log(`  Backend registered: ${regRes.status}`);
    
  } else if (action === "dispute") {
    const [escrowIdStr, ...reasonParts] = args;
    const reason = reasonParts.join(" ");
    const escrowId = parseInt(escrowIdStr);
    const escrowIdBuf = Buffer.alloc(8);
    escrowIdBuf.writeBigUInt64LE(BigInt(escrowId));

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowIdBuf], PROGRAM_ID
    );

    const disc = anchorDisc("raise_dispute");
    const data = Buffer.concat([disc, encodeU64(escrowId)]);
    const keys = [
      { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
    ];
    const ix = new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
    const tx = new Transaction().add(ix);
    
    console.log(`Raising dispute on escrow #${escrowId}...`);
    console.log(`  Reason: ${reason}`);
    const sig = await sendAndConfirmTransaction(connection, tx, [buyer]);
    console.log(`✅ Dispute raised on-chain! TX: ${sig}`);

    // Trigger Grok arbitration
    console.log(`Triggering Grok 4.1 arbitration...`);
    const apiRes = await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/dispute`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const ruling = await apiRes.json();
    if (ruling.arbitration) {
      console.log(`⚖️ Grok ruling: ${ruling.arbitration.finalRuling}`);
      console.log(`   Confidence: ${ruling.arbitration.confidence}`);
      console.log(`   Reasoning: ${ruling.arbitration.reasoning}`);
    } else {
      console.log(`Response:`, JSON.stringify(ruling).slice(0, 500));
    }

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

    const res = await fetch(`${BACKEND_URL}/api/jobs/${escrowId}`);
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
    console.log("  npx tsx scripts/ash-buyer.ts create <description> <payment> <buyerCol> <sellerCol>");
    console.log("  npx tsx scripts/ash-buyer.ts approve <escrowId>");
    console.log("  npx tsx scripts/ash-buyer.ts dispute <escrowId> <reason...>");
  }
}

main().catch(console.error);
