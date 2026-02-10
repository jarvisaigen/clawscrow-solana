/**
 * On-chain operations for Clawscrow
 * Server-side signing for agent-to-agent transactions
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");

// Load IDL
const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/clawscrow.json"), "utf-8"));

// Agent wallets managed by the server
interface AgentWallet {
  keypair: Keypair;
  tokenAccount?: PublicKey;
}

const agentWallets: Map<string, AgentWallet> = new Map();
let connection: Connection;
let program: anchor.Program;
let treasuryKeypair: Keypair;
let usdcMint: PublicKey;
let arbitratorKeypair: Keypair;
let initialized = false;

export async function initOnChain(): Promise<void> {
  if (initialized) return;
  
  connection = new Connection(DEVNET_URL, "confirmed");
  
  // Treasury keypair (deployer) — funds new agent wallets
  const envKey = process.env.TREASURY_KEYPAIR;
  if (envKey) {
    try {
      if (envKey.startsWith("[")) {
        // JSON array in env var
        treasuryKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envKey)));
      } else if (fs.existsSync(envKey)) {
        // File path
        treasuryKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(envKey, "utf-8"))));
      } else {
        treasuryKeypair = Keypair.generate();
        console.log("  ⚠️ TREASURY_KEYPAIR invalid, generated ephemeral");
      }
    } catch {
      treasuryKeypair = Keypair.generate();
      console.log("  ⚠️ TREASURY_KEYPAIR parse error, generated ephemeral");
    }
  } else {
    const defaultPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    if (fs.existsSync(defaultPath)) {
      treasuryKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(defaultPath, "utf-8"))));
    } else {
      treasuryKeypair = Keypair.generate();
      console.log("  ⚠️ No treasury keypair found, generated ephemeral");
    }
  }

  // Setup Anchor provider
  const wallet = new anchor.Wallet(treasuryKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  program = new anchor.Program(IDL, provider);

  // Arbitrator keypair — use env var, fall back to treasury (deployer)
  const arbKey = process.env.ARBITRATOR_KEYPAIR;
  if (arbKey) {
    try {
      if (arbKey.startsWith("[")) {
        arbitratorKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(arbKey)));
      } else if (fs.existsSync(arbKey)) {
        arbitratorKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(arbKey, "utf-8"))));
      } else {
        arbitratorKeypair = treasuryKeypair;
        console.log("  ⚠️ ARBITRATOR_KEYPAIR invalid, using treasury");
      }
    } catch {
      arbitratorKeypair = treasuryKeypair;
      console.log("  ⚠️ ARBITRATOR_KEYPAIR parse error, using treasury");
    }
  } else {
    arbitratorKeypair = treasuryKeypair;
    console.log("  ℹ️ No ARBITRATOR_KEYPAIR, using treasury as arbitrator");
  }
  console.log("  Arbitrator:", arbitratorKeypair.publicKey.toBase58());

  // USDC mint — reuse from env or create new
  const envMint = process.env.USDC_MINT;
  if (envMint) {
    try {
      usdcMint = new PublicKey(envMint);
      // Verify it exists on-chain
      const mintInfo = await connection.getAccountInfo(usdcMint);
      if (mintInfo) {
        console.log("  USDC Mint (env):", usdcMint.toBase58());
      } else {
        throw new Error("Mint not found on-chain");
      }
    } catch (e: any) {
      console.log("  ⚠️ USDC_MINT env invalid:", e.message, "— creating new");
      usdcMint = await createMint(connection, treasuryKeypair, treasuryKeypair.publicKey, null, 6);
      console.log("  USDC Mint (new):", usdcMint.toBase58());
      console.log("  💡 Set USDC_MINT=" + usdcMint.toBase58() + " in env to persist");
    }
  } else {
    try {
      usdcMint = await createMint(connection, treasuryKeypair, treasuryKeypair.publicKey, null, 6);
      console.log("  USDC Mint (new):", usdcMint.toBase58());
      console.log("  💡 Set USDC_MINT=" + usdcMint.toBase58() + " in env to persist");
    } catch (e: any) {
      console.error("  ⚠️ Failed to create USDC mint:", e.message);
    }
  }

  initialized = true;
  console.log("  ✅ On-chain initialized");
}

async function fundWallet(pubkey: PublicKey, solAmount: number): Promise<void> {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasuryKeypair.publicKey,
      toPubkey: pubkey,
      lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    })
  );
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  await provider.sendAndConfirm(tx);
}

export async function registerAgent(agentId: string): Promise<{ publicKey: string; funded: boolean }> {
  if (agentWallets.has(agentId)) {
    const w = agentWallets.get(agentId)!;
    return { publicKey: w.keypair.publicKey.toBase58(), funded: true };
  }

  const kp = Keypair.generate();
  await fundWallet(kp.publicKey, 0.02); // 0.02 SOL for gas + PDA rent

  // Create USDC token account and mint test tokens
  const tokenAccount = await createAccount(connection, treasuryKeypair, usdcMint, kp.publicKey);
  await mintTo(connection, treasuryKeypair, usdcMint, tokenAccount, treasuryKeypair.publicKey, 100_000); // 0.1 USDC

  agentWallets.set(agentId, { keypair: kp, tokenAccount });
  console.log(`  Agent ${agentId} registered:`, kp.publicKey.toBase58());
  return { publicKey: kp.publicKey.toBase58(), funded: true };
}

function getAgent(agentId: string): AgentWallet {
  const w = agentWallets.get(agentId);
  if (!w) throw new Error(`Agent ${agentId} not registered. Call POST /api/agents/register first.`);
  return w;
}

function deriveEscrowPDA(escrowId: anchor.BN): [PublicKey, PublicKey] {
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), escrowId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrowId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
  return [escrowPda, vaultPda];
}

export interface EscrowResult {
  escrowId: string;
  escrowPda: string;
  txSignature: string;
  state: string;
}

export async function createEscrow(
  buyerAgentId: string,
  description: string,
  paymentAmount: number,
  buyerCollateral: number,
  sellerCollateral: number,
): Promise<EscrowResult> {
  const buyer = getAgent(buyerAgentId);
  const escrowId = new anchor.BN(Date.now());
  const [escrowPda, vaultPda] = deriveEscrowPDA(escrowId);
  const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

  // Need a buyer token account with enough USDC
  const buyerToken = buyer.tokenAccount!;

  // Mint extra if needed
  const balance = (await getAccount(connection, buyerToken)).amount;
  const needed = BigInt(paymentAmount + buyerCollateral);
  if (balance < needed) {
    await mintTo(connection, treasuryKeypair, usdcMint, buyerToken, treasuryKeypair.publicKey, Number(needed - balance) + 1000);
  }

  const tx = await program.methods
    .createEscrow(
      escrowId,
      description,
      new anchor.BN(paymentAmount),
      new anchor.BN(buyerCollateral),
      new anchor.BN(sellerCollateral),
      deadline
    )
    .accounts({
      buyer: buyer.keypair.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken,
      usdcMint,
      arbitrator: arbitratorKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer.keypair])
    .rpc();

  return { escrowId: escrowId.toString(), escrowPda: escrowPda.toBase58(), txSignature: tx, state: "created" };
}

export async function acceptEscrow(sellerAgentId: string, escrowId: string): Promise<EscrowResult> {
  const seller = getAgent(sellerAgentId);
  const eid = new anchor.BN(escrowId);
  const [escrowPda, vaultPda] = deriveEscrowPDA(eid);

  // Get escrow to check seller collateral needed
  const escrowData = await program.account.escrow.fetch(escrowPda);
  const sellerCol = (escrowData as any).sellerCollateral.toNumber();

  // Ensure seller has enough USDC
  const balance = (await getAccount(connection, seller.tokenAccount!)).amount;
  if (balance < BigInt(sellerCol)) {
    await mintTo(connection, treasuryKeypair, usdcMint, seller.tokenAccount!, treasuryKeypair.publicKey, sellerCol + 1000);
  }

  const tx = await program.methods
    .acceptEscrow(eid)
    .accounts({
      seller: seller.keypair.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      sellerToken: seller.tokenAccount!,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([seller.keypair])
    .rpc();

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: tx, state: "accepted" };
}

export async function deliverEscrow(sellerAgentId: string, escrowId: string, contentHash: string): Promise<EscrowResult> {
  const seller = getAgent(sellerAgentId);
  const eid = new anchor.BN(escrowId);
  const [escrowPda] = deriveEscrowPDA(eid);

  // Convert content hash to 32 bytes
  const hashBytes = Array.from(Buffer.from(contentHash.padEnd(32, '\0'), 'utf-8').slice(0, 32));

  const tx = await program.methods
    .deliver(hashBytes)
    .accounts({
      seller: seller.keypair.publicKey,
      escrow: escrowPda,
    })
    .signers([seller.keypair])
    .rpc();

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: tx, state: "delivered" };
}

export async function approveEscrow(buyerAgentId: string, escrowId: string): Promise<EscrowResult> {
  const buyer = getAgent(buyerAgentId);
  const eid = new anchor.BN(escrowId);
  const [escrowPda, vaultPda] = deriveEscrowPDA(eid);

  // Get escrow data for seller token
  const escrowData = await program.account.escrow.fetch(escrowPda);
  const sellerPubkey = (escrowData as any).seller as PublicKey;

  // Find seller's agent wallet
  let sellerToken: PublicKey | undefined;
  for (const [, w] of agentWallets) {
    if (w.keypair.publicKey.equals(sellerPubkey)) {
      sellerToken = w.tokenAccount;
      break;
    }
  }
  if (!sellerToken) throw new Error("Seller token account not found");

  const tx = await program.methods
    .approve(eid)
    .accounts({
      signer: buyer.keypair.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken: buyer.tokenAccount!,
      sellerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer.keypair])
    .rpc();

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: tx, state: "approved" };
}

export async function resolveDispute(escrowId: string, ruling: "BuyerWins" | "SellerWins"): Promise<EscrowResult> {
  const eid = new anchor.BN(escrowId);
  const [escrowPda, vaultPda] = deriveEscrowPDA(eid);

  // Get escrow data for buyer/seller tokens
  const escrowData = await program.account.escrow.fetch(escrowPda);
  const buyerPubkey = (escrowData as any).buyer as PublicKey;
  const sellerPubkey = (escrowData as any).seller as PublicKey;

  // Find buyer and seller token accounts
  let buyerToken: PublicKey | undefined;
  let sellerToken: PublicKey | undefined;
  for (const [, w] of agentWallets) {
    if (w.keypair.publicKey.equals(buyerPubkey)) buyerToken = w.tokenAccount;
    if (w.keypair.publicKey.equals(sellerPubkey)) sellerToken = w.tokenAccount;
  }
  if (!buyerToken) throw new Error("Buyer token account not found");
  if (!sellerToken) throw new Error("Seller token account not found");

  const rulingArg = ruling === "BuyerWins" ? { buyerWins: {} } : { sellerWins: {} };

  const tx = await program.methods
    .arbitrate(eid, rulingArg)
    .accounts({
      arbitrator: arbitratorKeypair.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerToken,
      sellerToken,
      arbitratorToken: arbitratorKeypair.publicKey, // arbitrator fee goes here
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([arbitratorKeypair])
    .rpc();

  const state = ruling === "BuyerWins" ? "resolved_buyer" : "resolved_seller";
  console.log(`[On-chain] Dispute resolved: ${ruling}, tx: ${tx}`);
  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: tx, state };
}

export async function getEscrowOnChain(escrowId: string): Promise<any> {
  const eid = new anchor.BN(escrowId);
  const [escrowPda] = deriveEscrowPDA(eid);
  try {
    return await program.account.escrow.fetch(escrowPda);
  } catch {
    return null;
  }
}
