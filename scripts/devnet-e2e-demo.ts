import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const DEVNET_RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const EXPLORER = "https://explorer.solana.com/tx/";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function airdropWithRetry(conn: Connection, pubkey: PublicKey, amount: number, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const sig = await conn.requestAirdrop(pubkey, amount);
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`  ✅ Airdrop ${amount / LAMPORTS_PER_SOL} SOL to ${pubkey.toBase58()}`);
      return;
    } catch (e: any) {
      console.log(`  ⚠️ Airdrop attempt ${i + 1} failed: ${e.message?.slice(0, 80)}`);
      if (i < retries - 1) await sleep(3000 * (i + 1));
    }
  }
  throw new Error(`Airdrop failed after ${retries} retries for ${pubkey.toBase58()}`);
}

async function fundViaTransfer(conn: Connection, from: Keypair, to: PublicKey, amount: number) {
  const tx = new web3.Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: amount })
  );
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [from]);
  console.log(`  ✅ Transferred ${amount / LAMPORTS_PER_SOL} SOL to ${to.toBase58()}`);
  return sig;
}

async function main() {
  console.log("🚀 Clawscrow Devnet E2E Demo");
  console.log("=".repeat(60));
  console.log(`RPC: ${DEVNET_RPC}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}\n`);

  // Load deployer keypair (= buyer)
  const deployerSecret = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../deploy-keypair.json"), "utf-8")
  );
  const buyer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  console.log(`👤 Buyer (deployer): ${buyer.publicKey.toBase58()}`);

  const conn = new Connection(DEVNET_RPC, "confirmed");

  // Check buyer balance
  const buyerBal = await conn.getBalance(buyer.publicKey);
  console.log(`   Balance: ${buyerBal / LAMPORTS_PER_SOL} SOL`);

  // Create seller + arbitrator keypairs
  const seller = Keypair.generate();
  const arbitrator = Keypair.generate();
  console.log(`👤 Seller: ${seller.publicKey.toBase58()}`);
  console.log(`👤 Arbitrator: ${arbitrator.publicKey.toBase58()}`);

  // Fund seller and arbitrator
  console.log("\n📦 Funding accounts...");
  const fundAmount = 0.05 * LAMPORTS_PER_SOL;

  // Try airdrop first, fallback to transfer from deployer
  for (const [name, kp] of [["Seller", seller], ["Arbitrator", arbitrator]] as [string, Keypair][]) {
    try {
      await airdropWithRetry(conn, kp.publicKey, fundAmount, 2);
    } catch {
      console.log(`  🔄 Airdrop failed for ${name}, funding via transfer...`);
      await fundViaTransfer(conn, buyer, kp.publicKey, fundAmount);
    }
    await sleep(1000);
  }

  // Set up Anchor provider with buyer as wallet
  const wallet = new anchor.Wallet(buyer);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // Load IDL
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../target/idl/clawscrow.json"), "utf-8")
  );
  const program = new Program(idl, PROGRAM_ID, provider);

  // Create test SPL token mint ("USDC")
  console.log("\n🪙 Creating test USDC mint...");
  const mint = await createMint(conn, buyer, buyer.publicKey, null, 6);
  console.log(`   Mint: ${mint.toBase58()}`);

  // Create ATAs and mint tokens
  const buyerAta = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, buyer.publicKey);
  const sellerAta = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, seller.publicKey);
  console.log(`   Buyer ATA: ${buyerAta.address.toBase58()}`);
  console.log(`   Seller ATA: ${sellerAta.address.toBase58()}`);

  const mintAmount = 1_000_000_000; // 1000 USDC (6 decimals)
  await mintTo(conn, buyer, mint, buyerAta.address, buyer, mintAmount);
  await mintTo(conn, buyer, mint, sellerAta.address, buyer, mintAmount);
  console.log(`   Minted 1000 USDC to buyer and seller`);

  // Escrow parameters
  const escrowId = new BN(Date.now());
  const paymentAmount = new BN(100_000_000); // 100 USDC
  const collateralAmount = new BN(50_000_000); // 50 USDC
  const descriptionHash = Array.from(crypto.createHash("sha256").update("Clawscrow E2E demo").digest());
  const deliveryHash = Array.from(crypto.createHash("sha256").update("Work delivered!").digest());

  // Derive PDAs
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), buyer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrowPda.toBuffer()],
    PROGRAM_ID
  );
  console.log(`\n🔐 Escrow PDA: ${escrowPda.toBase58()}`);
  console.log(`🔐 Vault PDA: ${vaultPda.toBase58()}`);

  const txLinks: { step: string; sig: string }[] = [];
  const link = (sig: string) => `${EXPLORER}${sig}?cluster=devnet`;

  // 1. CREATE ESCROW
  console.log("\n━━━ Step 1: createEscrow ━━━");
  const createTx = await program.methods
    .createEscrow(escrowId, paymentAmount, collateralAmount, descriptionHash)
    .accounts({
      buyer: buyer.publicKey,
      arbitrator: arbitrator.publicKey,
      mint,
      escrow: escrowPda,
      vault: vaultPda,
      buyerTokenAccount: buyerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();
  console.log(`✅ createEscrow: ${createTx}`);
  console.log(`🔗 ${link(createTx)}`);
  txLinks.push({ step: "createEscrow", sig: createTx });
  await sleep(2000);

  // 2. ACCEPT ESCROW
  console.log("\n━━━ Step 2: acceptEscrow ━━━");
  const acceptTx = await program.methods
    .acceptEscrow()
    .accounts({
      seller: seller.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      sellerTokenAccount: sellerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([seller])
    .rpc();
  console.log(`✅ acceptEscrow: ${acceptTx}`);
  console.log(`🔗 ${link(acceptTx)}`);
  txLinks.push({ step: "acceptEscrow", sig: acceptTx });
  await sleep(2000);

  // 3. DELIVER
  console.log("\n━━━ Step 3: deliver ━━━");
  const deliverTx = await program.methods
    .deliver(deliveryHash)
    .accounts({
      seller: seller.publicKey,
      escrow: escrowPda,
    })
    .signers([seller])
    .rpc();
  console.log(`✅ deliver: ${deliverTx}`);
  console.log(`🔗 ${link(deliverTx)}`);
  txLinks.push({ step: "deliver", sig: deliverTx });
  await sleep(2000);

  // 4. APPROVE
  console.log("\n━━━ Step 4: approve ━━━");
  const approveTx = await program.methods
    .approve()
    .accounts({
      caller: buyer.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      sellerTokenAccount: sellerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  console.log(`✅ approve: ${approveTx}`);
  console.log(`🔗 ${link(approveTx)}`);
  txLinks.push({ step: "approve", sig: approveTx });

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("🎉 E2E DEMO COMPLETE — All 4 steps succeeded!");
  console.log("=".repeat(60));
  for (const { step, sig } of txLinks) {
    console.log(`\n${step}:`);
    console.log(`  ${link(sig)}`);
  }
  console.log();
}

main().catch((e) => {
  console.error("❌ Demo failed:", e);
  process.exit(1);
});
