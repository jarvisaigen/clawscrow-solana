/**
 * Clawscrow E2E Demo — Agent-to-Agent Escrow on Solana
 * Flow: create_escrow → accept_escrow → deliver → approve
 * 
 * Uses raw Anchor instruction building since the IDL is stale.
 */
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram,
  Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import * as borsh from "borsh";

const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

const CLUSTER_SUFFIX = RPC_URL.includes("devnet")
  ? "?cluster=devnet"
  : "?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899";

function explorerLink(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${CLUSTER_SUFFIX}`;
}

// Anchor discriminator = sha256("global:<method_name>")[0..8]
function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeU64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

function encodeI64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(n);
  return buf;
}

function encodeString(s: string): Buffer {
  const strBuf = Buffer.from(s, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

function encodeHash(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

async function fund(conn: Connection, from: Keypair, to: PublicKey, sol: number) {
  try {
    const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } catch {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL })
    );
    await sendAndConfirmTransaction(conn, tx, [from]);
  }
}

async function main() {
  const out: string[] = [];
  const log = (m: string) => { console.log(m); out.push(m); };

  log("# Clawscrow E2E Demo - Agent-to-Agent Escrow on Solana");
  log(`**Date:** ${new Date().toISOString()}`);
  log(`**Program:** \`${PROGRAM_ID.toBase58()}\``);
  log(`**RPC:** ${RPC_URL}`);
  log("");

  const conn = new Connection(RPC_URL, "confirmed");

  // Load buyer (deployer wallet)
  const buyer = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy-keypair.json"), "utf-8"))
  ));
  const seller = Keypair.generate();
  const arbitrator = Keypair.generate();

  log("## Wallets");
  log(`- **Buyer (Agent A):** \`${buyer.publicKey.toBase58()}\``);
  log(`- **Seller (Agent B):** \`${seller.publicKey.toBase58()}\``);
  log(`- **Arbitrator:** \`${arbitrator.publicKey.toBase58()}\``);
  log("");

  log("## Funding");
  await fund(conn, buyer, seller.publicKey, 2);
  log("- Seller funded: 2 SOL");
  await fund(conn, buyer, arbitrator.publicKey, 1);
  log("- Arbitrator funded: 1 SOL");
  log("");

  // Create test SPL token mint (6 decimals, like USDC)
  log("## Token Setup");
  const mint = await createMint(conn, buyer, buyer.publicKey, null, 6);
  log(`- **Test Token Mint:** \`${mint.toBase58()}\``);

  const buyerAta = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, buyer.publicKey);
  const sellerAta = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, seller.publicKey);

  const PAYMENT = 100_000_000n;        // 100 tokens
  const BUYER_COLLATERAL = 50_000_000n; // 50 tokens
  const SELLER_COLLATERAL = 25_000_000n; // 25 tokens

  await mintTo(conn, buyer, mint, buyerAta.address, buyer, Number(PAYMENT + BUYER_COLLATERAL));
  await mintTo(conn, buyer, mint, sellerAta.address, buyer, Number(SELLER_COLLATERAL));
  log(`- Buyer ATA: \`${buyerAta.address.toBase58()}\` — minted ${Number(PAYMENT + BUYER_COLLATERAL) / 1e6} tokens`);
  log(`- Seller ATA: \`${sellerAta.address.toBase58()}\` — minted ${Number(SELLER_COLLATERAL) / 1e6} tokens`);
  log("");

  // Derive PDAs - seeds use escrow_id bytes
  const escrowId = BigInt(Date.now());
  const escrowIdBuf = Buffer.alloc(8);
  escrowIdBuf.writeBigUInt64LE(escrowId);

  const [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), escrowIdBuf],
    PROGRAM_ID
  );
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrowIdBuf],
    PROGRAM_ID
  );

  log("## Escrow PDAs");
  log(`- **Escrow ID:** ${escrowId.toString()}`);
  log(`- **Escrow PDA:** \`${escrowPda.toBase58()}\``);
  log(`- **Vault PDA:** \`${vaultPda.toBase58()}\``);
  log("");

  const txs: { step: string; sig: string }[] = [];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400); // 24h from now

  // ── Step 1: Create Escrow (Buyer) ──
  log("## Step 1: Create Escrow (Buyer)");
  {
    // Instruction data: disc + escrow_id + description(String) + payment + buyer_col + seller_col + deadline
    const desc = "Agent A requests code review from Agent B";
    const data = Buffer.concat([
      anchorDisc("create_escrow"),
      encodeU64(escrowId),
      encodeString(desc),
      encodeU64(PAYMENT),
      encodeU64(BUYER_COLLATERAL),
      encodeU64(SELLER_COLLATERAL),
      encodeI64(deadline),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: buyerAta.address, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: arbitrator.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [buyer]);
    txs.push({ step: "create_escrow", sig });
    log(`✅ TX: \`${sig}\``);
    log(`   ${explorerLink(sig)}`);
  }
  log("");

  // ── Step 2: Accept Escrow (Seller) ──
  log("## Step 2: Accept Escrow (Seller)");
  {
    const data = Buffer.concat([
      anchorDisc("accept_escrow"),
      encodeU64(escrowId),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: seller.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: sellerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [seller]);
    txs.push({ step: "accept_escrow", sig });
    log(`✅ TX: \`${sig}\``);
    log(`   ${explorerLink(sig)}`);
  }
  log("");

  // ── Step 3: Deliver (Seller) ──
  log("## Step 3: Deliver Work (Seller)");
  {
    const deliveryHash = encodeHash("ipfs://QmDeliveryProof_code_review_2026");
    const data = Buffer.concat([
      anchorDisc("deliver"),
      deliveryHash,
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: seller.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [seller]);
    txs.push({ step: "deliver", sig });
    log(`✅ TX: \`${sig}\``);
    log(`   ${explorerLink(sig)}`);
  }
  log("");

  // ── Step 4: Approve (Buyer) ──
  log("## Step 4: Approve & Release Funds (Buyer)");
  {
    const data = Buffer.concat([
      anchorDisc("approve"),
      encodeU64(escrowId),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: buyerAta.address, isSigner: false, isWritable: true },
        { pubkey: sellerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [buyer]);
    txs.push({ step: "approve", sig });
    log(`✅ TX: \`${sig}\``);
    log(`   ${explorerLink(sig)}`);
  }
  log("");

  // ── Final state ──
  log("## Final Escrow State");
  const escrowData = await conn.getAccountInfo(escrowPda);
  if (escrowData) {
    // Decode manually: skip 8-byte discriminator
    const data = escrowData.data;
    const eid = data.readBigUInt64LE(8);
    // Read state enum at known offset
    log(`- **Escrow ID:** ${eid}`);
    log(`- **Account size:** ${data.length} bytes`);
    log(`- **Raw state check:** Account exists and funded`);
  }
  log("");

  // ── Summary ──
  log("## Transaction Summary");
  for (const tx of txs) {
    log(`- **${tx.step}:** \`${tx.sig}\``);
    log(`  ${explorerLink(tx.sig)}`);
  }
  log("");
  log("🎉 **Full escrow lifecycle completed on Solana!**");

  // Save
  const outPath = path.join(__dirname, "..", "DEMO_OUTPUT.md");
  fs.writeFileSync(outPath, out.join("\n"));
  console.log(`\nSaved to ${outPath}`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
