/**
 * Clawscrow Agent Client — Local signing, no custodial backend
 * 
 * Each agent signs transactions with their own keypair directly against Solana.
 * The backend is only used for file storage and AI arbitration.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");
const USDC_MINT = new PublicKey("CMfut37JaZLSXrZFbExqLUfoSq7AV95TZyLtXLyVHzyh");
const ARBITRATOR = new PublicKey("DF26XZhyKWH4MeSQ1yfEQxBB22vg2EYWS2BfkX1fCUZb");
const BACKEND_URL = process.env.BACKEND_URL || "https://clawscrow-solana-production.up.railway.app";

// Load IDL
const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/clawscrow.json"), "utf-8"));

function loadKeypair(keypairPath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getEscrowPDA(escrowId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(escrowId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), buf],
    PROGRAM_ID
  );
}

function getVaultPDA(escrowId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(escrowId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), buf],
    PROGRAM_ID
  );
}

async function getProgram(signer: Keypair): Promise<anchor.Program> {
  const connection = new Connection(DEVNET_URL, "confirmed");
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  return new anchor.Program(IDL, provider);
}

// ─────────────────── BUYER ACTIONS ───────────────────

export async function createEscrow(
  buyerKeypairPath: string,
  description: string,
  paymentUsdc: number,
  buyerCollateralUsdc: number,
  sellerCollateralUsdc: number,
): Promise<{ escrowId: number; txSignature: string }> {
  const buyer = loadKeypair(buyerKeypairPath);
  const program = await getProgram(buyer);
  const connection = program.provider.connection;

  const escrowId = Date.now();
  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);

  const buyerToken = await getAssociatedTokenAddress(USDC_MINT, buyer.publicKey);
  const deadlineTs = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days

  // Convert USDC amounts to 6-decimal raw
  const payment = Math.round(paymentUsdc * 1_000_000);
  const buyerColl = Math.round(buyerCollateralUsdc * 1_000_000);
  const sellerColl = Math.round(sellerCollateralUsdc * 1_000_000);

  const tx = await (program.methods as any)
    .createEscrow(
      new anchor.BN(escrowId),
      description,
      new anchor.BN(payment),
      new anchor.BN(buyerColl),
      new anchor.BN(sellerColl),
      new anchor.BN(deadlineTs),
    )
    .accounts({
      buyer: buyer.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken,
      usdcMint: USDC_MINT,
      arbitrator: ARBITRATOR,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();

  console.log(`✅ Escrow created: ${escrowId}`);
  console.log(`   PDA: ${escrowPda.toBase58()}`);
  console.log(`   TX: ${tx}`);
  console.log(`   Buyer: ${buyer.publicKey.toBase58()}`);

  // Register with backend for tracking
  await fetch(`${BACKEND_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      escrowId: escrowId.toString(),
      description,
      buyer: buyer.publicKey.toBase58(),
      paymentAmount: paymentUsdc,
      buyerCollateral: buyerCollateralUsdc,
      sellerCollateral: sellerCollateralUsdc,
    }),
  });

  return { escrowId, txSignature: tx };
}

// ─────────────────── SELLER ACTIONS ───────────────────

export async function acceptEscrow(
  sellerKeypairPath: string,
  escrowId: number,
): Promise<string> {
  const seller = loadKeypair(sellerKeypairPath);
  const program = await getProgram(seller);

  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);
  const sellerToken = await getAssociatedTokenAddress(USDC_MINT, seller.publicKey);

  const tx = await (program.methods as any)
    .acceptEscrow(new anchor.BN(escrowId))
    .accounts({
      seller: seller.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      sellerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([seller])
    .rpc();

  console.log(`✅ Escrow ${escrowId} accepted by ${seller.publicKey.toBase58()}`);
  console.log(`   TX: ${tx}`);

  // Notify backend
  await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/accept`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seller: seller.publicKey.toBase58() }),
  });

  return tx;
}

export async function deliver(
  sellerKeypairPath: string,
  escrowId: number,
  filePath: string,
): Promise<{ txSignature: string; contentHash: string; fileId: string }> {
  const seller = loadKeypair(sellerKeypairPath);
  const program = await getProgram(seller);

  // Read and hash the file
  const content = fs.readFileSync(filePath);
  const contentHash = createHash("sha256").update(content).digest();
  const contentHashHex = contentHash.toString("hex");

  // Upload file to backend (encrypted)
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
  const hashArray = Array.from(contentHash);

  const tx = await (program.methods as any)
    .deliver(hashArray)
    .accounts({
      seller: seller.publicKey,
      escrow: escrowPda,
    })
    .signers([seller])
    .rpc();

  console.log(`✅ Delivery submitted for escrow ${escrowId}`);
  console.log(`   Content hash: ${contentHashHex}`);
  console.log(`   File ID: ${uploadData.fileId}`);
  console.log(`   TX: ${tx}`);

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

  return { txSignature: tx, contentHash: contentHashHex, fileId: uploadData.fileId };
}

// ─────────────────── BUYER POST-DELIVERY ───────────────────

export async function approve(
  buyerKeypairPath: string,
  escrowId: number,
): Promise<string> {
  const buyer = loadKeypair(buyerKeypairPath);
  const program = await getProgram(buyer);
  const connection = program.provider.connection;

  const [escrowPda] = getEscrowPDA(escrowId);
  const [vaultPda] = getVaultPDA(escrowId);

  // Need to fetch escrow to get seller
  const escrowAccount: any = await (program.account as any).escrow.fetch(escrowPda);
  const sellerPub = escrowAccount.seller as PublicKey;

  const buyerToken = await getOrCreateAssociatedTokenAccount(connection, buyer, USDC_MINT, buyer.publicKey);
  const sellerToken = await getOrCreateAssociatedTokenAccount(connection, buyer, USDC_MINT, sellerPub);

  const tx = await (program.methods as any)
    .approve()
    .accounts({
      buyer: buyer.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken: buyerToken.address,
      sellerToken: sellerToken.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();

  console.log(`✅ Escrow ${escrowId} approved — seller paid`);
  console.log(`   TX: ${tx}`);
  return tx;
}

export async function raiseDispute(
  buyerKeypairPath: string,
  escrowId: number,
  reason: string,
): Promise<string> {
  const buyer = loadKeypair(buyerKeypairPath);
  const program = await getProgram(buyer);

  const [escrowPda] = getEscrowPDA(escrowId);

  const tx = await (program.methods as any)
    .raiseDispute()
    .accounts({
      buyer: buyer.publicKey,
      escrow: escrowPda,
    })
    .signers([buyer])
    .rpc();

  console.log(`✅ Dispute raised for escrow ${escrowId}`);
  console.log(`   TX: ${tx}`);

  // Trigger AI arbitration on backend
  const arbRes = await fetch(`${BACKEND_URL}/api/jobs/${escrowId}/dispute`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const arbData: any = await arbRes.json();

  if (arbData.arbitration) {
    console.log(`   🤖 Grok ruling: ${arbData.arbitration.finalRuling}`);
    console.log(`   Confidence: ${arbData.arbitration.votes?.[0]?.confidence}`);
    console.log(`   On-chain TX: ${arbData.onChainTx}`);
  }

  return tx;
}

// ─────────────────── CLI ───────────────────

const [,, command, ...args] = process.argv;

(async () => {
  switch (command) {
    case "create": {
      const [keypairPath, description, payment, buyerColl, sellerColl] = args;
      await createEscrow(keypairPath, description, Number(payment), Number(buyerColl), Number(sellerColl));
      break;
    }
    case "accept": {
      const [keypairPath, escrowId] = args;
      await acceptEscrow(keypairPath, Number(escrowId));
      break;
    }
    case "deliver": {
      const [keypairPath, escrowId, filePath] = args;
      await deliver(keypairPath, Number(escrowId), filePath);
      break;
    }
    case "approve": {
      const [keypairPath, escrowId] = args;
      await approve(keypairPath, Number(escrowId));
      break;
    }
    case "dispute": {
      const [keypairPath, escrowId, ...reasonParts] = args;
      await raiseDispute(keypairPath, Number(escrowId), reasonParts.join(" "));
      break;
    }
    case "balance": {
      const keypairPath = args[0];
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
        console.log(`USDC: 0`);
      }
      break;
    }
    default:
      console.log(`
🦞 Clawscrow Agent Client — Local Signing

Usage: npx tsx client/agent-client.ts <command> [args]

Commands:
  balance <keypair>                                    Check wallet balance
  create  <keypair> <description> <pay> <bcoll> <scoll>  Create escrow (buyer)
  accept  <keypair> <escrowId>                          Accept escrow (seller)
  deliver <keypair> <escrowId> <filePath>               Deliver work (seller)
  approve <keypair> <escrowId>                          Approve delivery (buyer)
  dispute <keypair> <escrowId> <reason...>              Raise dispute (buyer)

Examples:
  npx tsx client/agent-client.ts balance ~/.config/solana/ash-agent.json
  npx tsx client/agent-client.ts create ~/jarvis-keypair.json "Write a haiku" 5 1 1
  npx tsx client/agent-client.ts accept ~/.config/solana/ash-agent.json 1770756009757
  npx tsx client/agent-client.ts deliver ~/.config/solana/ash-agent.json 1770756009757 ./haiku.txt
      `);
  }
})().catch(console.error);
