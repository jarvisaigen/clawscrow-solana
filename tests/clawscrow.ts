import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clawscrow } from "../target/types/clawscrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("clawscrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Clawscrow as Program<Clawscrow>;

  // Actors
  const buyer = anchor.web3.Keypair.generate();
  const seller = anchor.web3.Keypair.generate();
  const arbitrator = anchor.web3.Keypair.generate();
  const protocolFeeWallet = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let buyerAta: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let protocolFeeAta: anchor.web3.PublicKey;

  const escrowId = new anchor.BN(1);
  const paymentAmount = new anchor.BN(100_000_000); // 100 USDC (6 decimals)
  const collateralAmount = new anchor.BN(10_000_000); // 10 USDC
  const descriptionHash = Buffer.alloc(32, 1);
  const deliveryHash = Buffer.alloc(32, 2);

  function findEscrowPda(id: anchor.BN) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  function findVaultPda(id: anchor.BN) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  before(async () => {
    // Airdrop SOL to all actors
    for (const kp of [buyer, seller, arbitrator, protocolFeeWallet]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create USDC-like mint
    mint = await createMint(
      provider.connection,
      buyer,
      buyer.publicKey,
      null,
      6
    );

    // Create ATAs
    buyerAta = await createAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );
    sellerAta = await createAccount(
      provider.connection,
      seller,
      mint,
      seller.publicKey
    );
    protocolFeeAta = await createAccount(
      provider.connection,
      protocolFeeWallet,
      mint,
      protocolFeeWallet.publicKey
    );

    // Mint tokens to buyer
    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerAta,
      buyer,
      200_000_000
    );
  });

  it("Creates an escrow", async () => {
    const [escrowPda] = findEscrowPda(escrowId);
    const [vaultPda] = findVaultPda(escrowId);

    await program.methods
      .createEscrow(
        escrowId,
        paymentAmount,
        collateralAmount,
        Array.from(descriptionHash)
      )
      .accounts({
        buyer: buyer.publicKey,
        arbitrator: arbitrator.publicKey,
        mint,
        escrow: escrowPda,
        vault: vaultPda,
        buyerTokenAccount: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.open !== undefined, true);
    assert.equal(escrow.paymentAmount.toNumber(), 100_000_000);

    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 110_000_000); // payment + collateral
  });

  it("Seller accepts escrow", async () => {
    const [escrowPda] = findEscrowPda(escrowId);
    const [vaultPda] = findVaultPda(escrowId);

    // Mint collateral to seller
    await mintTo(
      provider.connection,
      buyer,
      mint,
      sellerAta,
      buyer,
      10_000_000
    );

    await program.methods
      .acceptEscrow()
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        sellerTokenAccount: sellerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.active !== undefined, true);
    assert.equal(escrow.seller.toBase58(), seller.publicKey.toBase58());

    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 120_000_000); // payment + 2*collateral
  });

  it("Seller delivers work", async () => {
    const [escrowPda] = findEscrowPda(escrowId);

    await program.methods
      .deliver(Array.from(deliveryHash))
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
      })
      .signers([seller])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.delivered !== undefined, true);
    assert.deepEqual(escrow.deliveryHash, Array.from(deliveryHash));
  });

  it("Buyer approves delivery", async () => {
    const [escrowPda] = findEscrowPda(escrowId);
    const [vaultPda] = findVaultPda(escrowId);

    await program.methods
      .approve()
      .accounts({
        caller: buyer.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        sellerTokenAccount: sellerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.approved !== undefined, true);

    const sellerAccount = await getAccount(provider.connection, sellerAta);
    assert.equal(Number(sellerAccount.amount), 120_000_000); // payment + 2*collateral
  });

  // ─── Dispute flow (separate escrow) ─────────────────────────────────────

  const escrowId2 = new anchor.BN(2);

  it("Full dispute → arbitrate flow", async () => {
    const [escrowPda] = findEscrowPda(escrowId2);
    const [vaultPda] = findVaultPda(escrowId2);

    // Mint more tokens to buyer and seller
    await mintTo(provider.connection, buyer, mint, buyerAta, buyer, 200_000_000);
    await mintTo(provider.connection, buyer, mint, sellerAta, buyer, 10_000_000);

    // Create
    await program.methods
      .createEscrow(
        escrowId2,
        paymentAmount,
        collateralAmount,
        Array.from(descriptionHash)
      )
      .accounts({
        buyer: buyer.publicKey,
        arbitrator: arbitrator.publicKey,
        mint,
        escrow: escrowPda,
        vault: vaultPda,
        buyerTokenAccount: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    // Accept
    await program.methods
      .acceptEscrow()
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        sellerTokenAccount: sellerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // Deliver
    await program.methods
      .deliver(Array.from(deliveryHash))
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPda,
      })
      .signers([seller])
      .rpc();

    // Dispute
    await program.methods
      .dispute()
      .accounts({
        buyer: buyer.publicKey,
        escrow: escrowPda,
      })
      .signers([buyer])
      .rpc();

    let escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.disputed !== undefined, true);

    // Arbitrate — buyer wins
    const buyerBalanceBefore = Number(
      (await getAccount(provider.connection, buyerAta)).amount
    );

    await program.methods
      .arbitrate(true)
      .accounts({
        arbitrator: arbitrator.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        winnerTokenAccount: buyerAta,
        protocolFeeAccount: protocolFeeAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbitrator])
      .rpc();

    escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.state.resolved !== undefined, true);

    // Check fee: 1% of 120_000_000 = 1_200_000
    const feeAccount = await getAccount(provider.connection, protocolFeeAta);
    assert.equal(Number(feeAccount.amount), 1_200_000);

    // Winner gets 120_000_000 - 1_200_000 = 118_800_000
    const buyerBalanceAfter = Number(
      (await getAccount(provider.connection, buyerAta)).amount
    );
    assert.equal(buyerBalanceAfter - buyerBalanceBefore, 118_800_000);
  });
});
