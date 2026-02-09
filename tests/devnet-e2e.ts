import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clawscrow } from "../target/types/clawscrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";

describe("clawscrow devnet e2e", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Clawscrow as Program<Clawscrow>;
  const payer = provider.wallet as anchor.Wallet;

  // Load pre-funded wallets
  const seller = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/seller.json", "utf-8")))
  );
  const arbitrator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/arbitrator.json", "utf-8")))
  );

  let usdcMint: anchor.web3.PublicKey;
  let buyerToken: anchor.web3.PublicKey;
  let sellerToken: anchor.web3.PublicKey;
  let arbitratorToken: anchor.web3.PublicKey;

  // Use unique escrow ID based on timestamp to avoid collisions
  const ESCROW_ID = new anchor.BN(Date.now());
  const PAYMENT = new anchor.BN(1_000_000);
  const BUYER_COLLATERAL = new anchor.BN(100_000);
  const SELLER_COLLATERAL = new anchor.BN(50_000);
  const DEADLINE = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

  let escrowPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    console.log("Buyer:", payer.publicKey.toBase58());
    console.log("Seller:", seller.publicKey.toBase58());
    console.log("Arbitrator:", arbitrator.publicKey.toBase58());
    console.log("Escrow ID:", ESCROW_ID.toString());

    // Create a test USDC mint (we're the mint authority)
    usdcMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );
    console.log("USDC Mint:", usdcMint.toBase58());

    // Create token accounts
    buyerToken = await createAccount(provider.connection, payer.payer, usdcMint, payer.publicKey);
    sellerToken = await createAccount(provider.connection, payer.payer, usdcMint, seller.publicKey);
    arbitratorToken = await createAccount(provider.connection, payer.payer, usdcMint, arbitrator.publicKey);

    // Mint test USDC
    await mintTo(provider.connection, payer.payer, usdcMint, buyerToken, payer.payer, 10_000_000);
    await mintTo(provider.connection, payer.payer, usdcMint, sellerToken, payer.payer, 1_000_000);

    // Derive PDAs
    [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), ESCROW_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ESCROW_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    console.log("Escrow PDA:", escrowPda.toBase58());
    console.log("Vault PDA:", vaultPda.toBase58());
  });

  it("Full happy path on devnet", async () => {
    // 1. Create escrow
    console.log("\n--- Creating escrow ---");
    const createTx = await program.methods
      .createEscrow(ESCROW_ID, "Devnet E2E test - write a haiku", PAYMENT, BUYER_COLLATERAL, SELLER_COLLATERAL, DEADLINE)
      .accounts({
        buyer: payer.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        buyerToken,
        usdcMint,
        arbitrator: arbitrator.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("Create TX:", createTx);

    let escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { created: {} });
    console.log("✅ Escrow created");

    // 2. Accept
    console.log("\n--- Seller accepting ---");
    const acceptTx = await program.methods
      .acceptEscrow(ESCROW_ID)
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        sellerToken,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();
    console.log("Accept TX:", acceptTx);

    escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { accepted: {} });
    console.log("✅ Escrow accepted");

    // 3. Deliver
    console.log("\n--- Delivering work ---");
    const hash = Buffer.alloc(32);
    Buffer.from("cafebabe", "hex").copy(hash);

    const deliverTx = await program.methods
      .deliver(Array.from(hash) as any)
      .accounts({ seller: seller.publicKey, escrow: escrowPda })
      .signers([seller])
      .rpc();
    console.log("Deliver TX:", deliverTx);

    escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { delivered: {} });
    console.log("✅ Work delivered");

    // 4. Approve
    console.log("\n--- Buyer approving ---");
    const approveTx = await program.methods
      .approve(ESCROW_ID)
      .accounts({
        signer: payer.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        buyerToken,
        sellerToken,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("Approve TX:", approveTx);

    escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { approved: {} });
    console.log("✅ Escrow approved — funds released!");

    // Verify balances
    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 0, "Vault should be empty");
    console.log("✅ Vault empty — all funds distributed");
  });
});
