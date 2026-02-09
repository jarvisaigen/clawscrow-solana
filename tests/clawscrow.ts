import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clawscrow } from "../target/types/clawscrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("clawscrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Clawscrow as Program<Clawscrow>;
  const payer = provider.wallet as anchor.Wallet;

  let usdcMint: anchor.web3.PublicKey;
  let buyerToken: anchor.web3.PublicKey;
  let sellerToken: anchor.web3.PublicKey;
  let arbitratorToken: anchor.web3.PublicKey;

  const seller = anchor.web3.Keypair.generate();
  const arbitrator = anchor.web3.Keypair.generate();

  const ESCROW_ID = new anchor.BN(1);
  const PAYMENT = new anchor.BN(1_000_000); // 1 USDC (6 decimals)
  const BUYER_COLLATERAL = new anchor.BN(100_000); // 0.1 USDC
  const SELLER_COLLATERAL = new anchor.BN(50_000); // 0.05 USDC
  const DEADLINE = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

  let escrowPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    // Fund seller and arbitrator
    const sig1 = await provider.connection.requestAirdrop(seller.publicKey, 2e9);
    const sig2 = await provider.connection.requestAirdrop(arbitrator.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );

    // Create token accounts
    buyerToken = await createAccount(
      provider.connection,
      payer.payer,
      usdcMint,
      payer.publicKey
    );
    sellerToken = await createAccount(
      provider.connection,
      payer.payer,
      usdcMint,
      seller.publicKey
    );
    arbitratorToken = await createAccount(
      provider.connection,
      payer.payer,
      usdcMint,
      arbitrator.publicKey
    );

    // Mint USDC to buyer and seller
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
  });

  it("Creates an escrow", async () => {
    await program.methods
      .createEscrow(
        ESCROW_ID,
        "Write a haiku about lobsters",
        PAYMENT,
        BUYER_COLLATERAL,
        SELLER_COLLATERAL,
        DEADLINE
      )
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

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.escrowId.toNumber(), 1);
    assert.equal(escrow.paymentAmount.toNumber(), 1_000_000);
    assert.deepEqual(escrow.state, { created: {} });
    assert.equal(escrow.description, "Write a haiku about lobsters");

    // Vault should have payment + buyer collateral
    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 1_100_000);
  });

  it("Seller accepts the escrow", async () => {
    await program.methods
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

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { accepted: {} });
    assert.ok(escrow.seller.equals(seller.publicKey));

    // Vault should now also have seller collateral
    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 1_150_000);
  });

  it("Seller delivers work", async () => {
    const hash = Buffer.alloc(32);
    Buffer.from("deadbeef", "hex").copy(hash);

    await program.methods
      .deliver(Array.from(hash) as any)
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
      })
      .signers([seller])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { delivered: {} });
    assert.ok(escrow.deliveredAt.toNumber() > 0);
  });

  it("Buyer approves delivery", async () => {
    const buyerBefore = await getAccount(provider.connection, buyerToken);
    const sellerBefore = await getAccount(provider.connection, sellerToken);

    await program.methods
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

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.state, { approved: {} });

    // Seller gets payment + seller collateral
    const sellerAfter = await getAccount(provider.connection, sellerToken);
    assert.equal(
      Number(sellerAfter.amount) - Number(sellerBefore.amount),
      1_050_000 // payment + seller_collateral
    );

    // Buyer gets buyer collateral back
    const buyerAfter = await getAccount(provider.connection, buyerToken);
    assert.equal(
      Number(buyerAfter.amount) - Number(buyerBefore.amount),
      100_000 // buyer_collateral
    );
  });

  // --- Dispute flow ---
  describe("Dispute flow", () => {
    const ESCROW_ID_2 = new anchor.BN(2);
    let escrowPda2: anchor.web3.PublicKey;
    let vaultPda2: anchor.web3.PublicKey;

    before(async () => {
      [escrowPda2] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), ESCROW_ID_2.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [vaultPda2] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), ESCROW_ID_2.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Mint more tokens
      await mintTo(provider.connection, payer.payer, usdcMint, buyerToken, payer.payer, 10_000_000);
      await mintTo(provider.connection, payer.payer, usdcMint, sellerToken, payer.payer, 1_000_000);

      // Create, accept, deliver
      await program.methods
        .createEscrow(ESCROW_ID_2, "Disputed task", PAYMENT, BUYER_COLLATERAL, SELLER_COLLATERAL, DEADLINE)
        .accounts({
          buyer: payer.publicKey,
          escrow: escrowPda2,
          vault: vaultPda2,
          buyerToken,
          usdcMint,
          arbitrator: arbitrator.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .acceptEscrow(ESCROW_ID_2)
        .accounts({ seller: seller.publicKey, escrow: escrowPda2, vault: vaultPda2, sellerToken, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID })
        .signers([seller])
        .rpc();

      await program.methods
        .deliver(Array.from(Buffer.alloc(32)) as any)
        .accounts({ seller: seller.publicKey, escrow: escrowPda2 })
        .signers([seller])
        .rpc();
    });

    it("Buyer raises dispute", async () => {
      await program.methods
        .raiseDispute()
        .accounts({ buyer: payer.publicKey, escrow: escrowPda2 })
        .rpc();

      const escrow = await program.account.escrow.fetch(escrowPda2);
      assert.deepEqual(escrow.state, { disputed: {} });
    });

    it("Arbitrator rules in buyer's favor", async () => {
      const buyerBefore = await getAccount(provider.connection, buyerToken);

      await program.methods
        .arbitrate(ESCROW_ID_2, { buyerWins: {} })
        .accounts({
          arbitrator: arbitrator.publicKey,
          escrow: escrowPda2,
          vault: vaultPda2,
          buyerToken,
          sellerToken,
          arbitratorToken,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([arbitrator])
        .rpc();

      const escrow = await program.account.escrow.fetch(escrowPda2);
      assert.deepEqual(escrow.state, { resolvedBuyer: {} });

      // Arbitrator gets 1% of buyer collateral
      const arbAccount = await getAccount(provider.connection, arbitratorToken);
      assert.equal(Number(arbAccount.amount), 1000); // 1% of 100_000

      // Buyer gets the rest (total pool - arb fee)
      const buyerAfter = await getAccount(provider.connection, buyerToken);
      const totalPool = 1_000_000 + 100_000 + 50_000;
      assert.equal(
        Number(buyerAfter.amount) - Number(buyerBefore.amount),
        totalPool - 1000
      );
    });
  });
});
