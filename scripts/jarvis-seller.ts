/**
 * Jarvis Seller — accepts and delivers on-chain using raw instructions
 * Usage: npx tsx scripts/jarvis-seller.ts <escrowId> <mint> <action> [escrowPda] [vaultPda] [sellerAta]
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const DEVNET_RPC = "https://api.devnet.solana.com";

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeU64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

function encodeHash(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

async function main() {
  const escrowId = process.argv[2];
  const mintAddress = process.argv[3];
  const action = process.argv[4] || "accept";

  if (!escrowId || !mintAddress) {
    console.error("Usage: npx tsx scripts/jarvis-seller.ts <escrowId> <mint> [accept|deliver]");
    process.exit(1);
  }

  const conn = new Connection(DEVNET_RPC, "confirmed");

  // Load Jarvis keypair
  const secret = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../jarvis-test-keypair.json"), "utf-8")
  );
  const seller = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log(`🤖 Jarvis Seller — ${action}`);
  console.log(`   Wallet: ${seller.publicKey.toBase58()}`);
  console.log(`   SOL: ${(await conn.getBalance(seller.publicKey)) / 1e9}`);

  const mint = new PublicKey(mintAddress);
  const escrowBN = BigInt(escrowId);

  // Derive PDAs (same as Ash's script)
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), encodeU64(escrowBN)],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), encodeU64(escrowBN)],
    PROGRAM_ID
  );

  console.log(`   Escrow PDA: ${escrowPda.toBase58()}`);
  console.log(`   Vault PDA: ${vaultPda.toBase58()}`);

  // Get seller ATA
  const sellerAta = await getOrCreateAssociatedTokenAccount(conn, seller, mint, seller.publicKey);
  console.log(`   Seller ATA: ${sellerAta.address.toBase58()}`);
  console.log(`   USDC: ${Number(sellerAta.amount) / 1e6}`);

  if (action === "accept") {
    console.log("\n━━━ Accept Escrow ━━━");
    const data = Buffer.concat([
      anchorDisc("accept_escrow"),
      encodeU64(escrowBN),
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
    console.log(`✅ Accept TX: ${sig}`);
    console.log(`🔗 https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  } else if (action === "deliver") {
    console.log("\n━━━ Deliver Work ━━━");
    const deliveryHash = encodeHash("Jarvis agent delivery: AI haiku about Solana escrow");
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
    console.log(`✅ Deliver TX: ${sig}`);
    console.log(`🔗 https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  }
}

main().catch((e) => {
  console.error("❌ Failed:", e.message || e);
  process.exit(1);
});
