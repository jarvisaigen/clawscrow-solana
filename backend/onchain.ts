/**
 * On-chain operations for Clawscrow
 * Uses raw instruction building (IDL has stale Ruling type)
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, TransactionInstruction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY
} from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");

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

function encodeHash(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

// Agent wallets managed by the server
interface AgentWallet {
  keypair: Keypair;
  tokenAccount?: PublicKey;
}

const agentWallets: Map<string, AgentWallet> = new Map();
let connection: Connection;
let treasuryKeypair: Keypair;
let usdcMint: PublicKey;
let arbitratorKeypair: Keypair;
let initialized = false;

export async function initOnChain(): Promise<void> {
  if (initialized) return;

  connection = new Connection(DEVNET_URL, "confirmed");

  // Treasury keypair — try env first (JSON array), then file path
  const envKey = process.env.TREASURY_KEYPAIR;
  if (envKey) {
    try {
      // Could be JSON array or file path
      if (envKey.startsWith("[")) {
        treasuryKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envKey)));
      } else if (fs.existsSync(envKey)) {
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
  console.log("  Treasury:", treasuryKeypair.publicKey.toBase58());

  // Arbitrator keypair
  arbitratorKeypair = Keypair.generate();
  await fundWallet(arbitratorKeypair.publicKey, 0.01);
  console.log("  Arbitrator:", arbitratorKeypair.publicKey.toBase58());

  // Create test USDC mint
  try {
    usdcMint = await createMint(connection, treasuryKeypair, treasuryKeypair.publicKey, null, 6);
    console.log("  USDC Mint:", usdcMint.toBase58());
  } catch (e: any) {
    console.error("  ⚠️ Failed to create USDC mint:", e.message);
  }

  initialized = true;
  console.log("  ✅ On-chain initialized");
}

async function fundWallet(pubkey: PublicKey, solAmount: number): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasuryKeypair.publicKey,
      toPubkey: pubkey,
      lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    })
  );
  await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);
}

function deriveEscrowPDA(escrowId: bigint): [PublicKey, PublicKey] {
  const idBuf = encodeU64(escrowId);
  const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), idBuf], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), idBuf], PROGRAM_ID);
  return [escrowPda, vaultPda];
}

export async function registerAgent(agentId: string): Promise<{ publicKey: string; funded: boolean }> {
  if (agentWallets.has(agentId)) {
    const w = agentWallets.get(agentId)!;
    return { publicKey: w.keypair.publicKey.toBase58(), funded: true };
  }

  const kp = Keypair.generate();
  await fundWallet(kp.publicKey, 0.02);

  const tokenAccount = await createAccount(connection, treasuryKeypair, usdcMint, kp.publicKey);
  await mintTo(connection, treasuryKeypair, usdcMint, tokenAccount, treasuryKeypair.publicKey, 10_000_000); // 10 USDC

  agentWallets.set(agentId, { keypair: kp, tokenAccount });
  console.log(`  Agent ${agentId} registered:`, kp.publicKey.toBase58());
  return { publicKey: kp.publicKey.toBase58(), funded: true };
}

function getAgent(agentId: string): AgentWallet {
  const w = agentWallets.get(agentId);
  if (!w) throw new Error(`Agent ${agentId} not registered. Call POST /api/agents/register first.`);
  return w;
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
  const escrowId = BigInt(Date.now());
  const [escrowPda, vaultPda] = deriveEscrowPDA(escrowId);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const descHash = encodeHash(description);

  // Ensure buyer has enough USDC
  const balance = (await getAccount(connection, buyer.tokenAccount!)).amount;
  const needed = BigInt(paymentAmount + buyerCollateral);
  if (balance < needed) {
    await mintTo(connection, treasuryKeypair, usdcMint, buyer.tokenAccount!, treasuryKeypair.publicKey, Number(needed - balance) + 1000);
  }

  const data = Buffer.concat([
    anchorDisc("create_escrow"),
    encodeU64(escrowId),
    descHash,
    encodeU64(BigInt(paymentAmount)),
    encodeU64(BigInt(buyerCollateral)),
    encodeU64(BigInt(sellerCollateral)),
    encodeI64(deadline),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: buyer.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: buyer.tokenAccount!, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: arbitratorKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer.keypair]);

  return { escrowId: escrowId.toString(), escrowPda: escrowPda.toBase58(), txSignature: sig, state: "created" };
}

export async function acceptEscrow(sellerAgentId: string, escrowId: string): Promise<EscrowResult> {
  const seller = getAgent(sellerAgentId);
  const eid = BigInt(escrowId);
  const [escrowPda, vaultPda] = deriveEscrowPDA(eid);

  // Ensure seller has enough USDC for collateral
  const balance = (await getAccount(connection, seller.tokenAccount!)).amount;
  if (balance < 1_000_000n) { // top up if low
    await mintTo(connection, treasuryKeypair, usdcMint, seller.tokenAccount!, treasuryKeypair.publicKey, 10_000_000);
  }

  const data = Buffer.concat([anchorDisc("accept_escrow"), encodeU64(eid)]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: seller.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: seller.tokenAccount!, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [seller.keypair]);

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: sig, state: "accepted" };
}

export async function deliverEscrow(sellerAgentId: string, escrowId: string, contentHash: string): Promise<EscrowResult> {
  const seller = getAgent(sellerAgentId);
  const eid = BigInt(escrowId);
  const [escrowPda] = deriveEscrowPDA(eid);

  const deliveryHash = encodeHash(contentHash);
  const data = Buffer.concat([anchorDisc("deliver"), deliveryHash]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: seller.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [seller.keypair]);

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: sig, state: "delivered" };
}

export async function approveEscrow(buyerAgentId: string, escrowId: string): Promise<EscrowResult> {
  const buyer = getAgent(buyerAgentId);
  const eid = BigInt(escrowId);
  const [escrowPda, vaultPda] = deriveEscrowPDA(eid);

  // Read escrow data to find seller token account
  const escrowInfo = await connection.getAccountInfo(new PublicKey(deriveEscrowPDA(eid)[0]));
  if (!escrowInfo) throw new Error("Escrow not found on chain");
  const sellerPubkey = new PublicKey(escrowInfo.data.subarray(48, 80));

  // Find seller's token account
  let sellerToken: PublicKey | undefined;
  for (const [, w] of agentWallets) {
    if (w.keypair.publicKey.equals(sellerPubkey)) {
      sellerToken = w.tokenAccount;
      break;
    }
  }
  if (!sellerToken) throw new Error("Seller token account not found");

  const data = Buffer.concat([anchorDisc("approve"), encodeU64(eid)]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: buyer.keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: buyer.tokenAccount!, isSigner: false, isWritable: true },
      { pubkey: sellerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer.keypair]);

  return { escrowId, escrowPda: escrowPda.toBase58(), txSignature: sig, state: "approved" };
}

export async function getEscrowOnChain(escrowId: string): Promise<any> {
  const eid = BigInt(escrowId);
  const [escrowPda] = deriveEscrowPDA(eid);
  try {
    const info = await connection.getAccountInfo(escrowPda);
    if (!info) return null;
    const d = info.data;
    const stateMap: Record<number, string> = { 0: "created", 1: "accepted", 2: "delivered", 3: "approved", 4: "disputed", 5: "resolved" };
    return {
      escrowId: d.readBigUInt64LE(8).toString(),
      buyer: new PublicKey(d.subarray(16, 48)).toBase58(),
      seller: new PublicKey(d.subarray(48, 80)).toBase58(),
      arbitrator: new PublicKey(d.subarray(80, 112)).toBase58(),
      mint: new PublicKey(d.subarray(112, 144)).toBase58(),
      paymentAmount: Number(d.readBigUInt64LE(144)),
      buyerCollateral: Number(d.readBigUInt64LE(152)),
      sellerCollateral: Number(d.readBigUInt64LE(160)),
      state: stateMap[d[168]] || `unknown(${d[168]})`,
    };
  } catch {
    return null;
  }
}

// List all escrows from chain
export async function listEscrowsOnChain(): Promise<any[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID);
  const stateMap: Record<number, string> = { 0: "created", 1: "accepted", 2: "delivered", 3: "approved", 4: "disputed", 5: "resolved" };
  return accounts
    .filter(a => a.account.data.length === 699)
    .map(a => {
      const d = a.account.data;
      return {
        escrowId: d.readBigUInt64LE(8).toString(),
        pda: a.pubkey.toBase58(),
        buyer: new PublicKey(d.subarray(16, 48)).toBase58(),
        seller: new PublicKey(d.subarray(48, 80)).toBase58(),
        mint: new PublicKey(d.subarray(112, 144)).toBase58(),
        paymentAmount: Number(d.readBigUInt64LE(144)),
        buyerCollateral: Number(d.readBigUInt64LE(152)),
        sellerCollateral: Number(d.readBigUInt64LE(160)),
        state: stateMap[d[168]] || `unknown(${d[168]})`,
      };
    });
}
