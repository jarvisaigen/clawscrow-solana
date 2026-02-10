/* Clawscrow IDL — matches deployed program 7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7 */
const CLAWSCROW_IDL = {
  address: "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7",
  instructions: {
    create_escrow: {
      discriminator: [253, 215, 165, 116, 36, 108, 68, 80],
      accounts: ["buyer", "escrow", "vault", "buyer_token", "usdc_mint", "arbitrator", "token_program", "system_program", "rent"],
      // args: escrow_id(u64), description(string), payment_amount(u64), buyer_collateral(u64), seller_collateral(u64), deadline_ts(i64)
    },
    accept_escrow: {
      discriminator: [193, 2, 224, 245, 36, 116, 65, 154],
      accounts: ["seller", "escrow", "vault", "seller_token", "token_program"],
      // args: escrow_id(u64)
    },
    deliver: {
      discriminator: [250, 131, 222, 57, 211, 229, 209, 147],
      accounts: ["seller", "escrow"],
      // args: delivery_hash([u8;32])
    },
    approve: {
      discriminator: [69, 74, 217, 36, 115, 117, 97, 76],
      accounts: ["signer", "escrow", "vault", "buyer_token", "seller_token", "token_program"],
      // args: escrow_id(u64)
    },
    raise_dispute: {
      discriminator: [41, 243, 1, 51, 150, 95, 246, 73],
      accounts: ["buyer", "escrow"],
      // args: none
    },
    arbitrate: {
      discriminator: [105, 91, 110, 150, 216, 11, 142, 142],
      accounts: ["arbitrator", "escrow", "vault", "buyer_token", "seller_token", "arbitrator_token", "token_program"],
      // args: escrow_id(u64), ruling(enum: 0=BuyerWins, 1=SellerWins)
    },
    auto_approve: {
      discriminator: [36, 58, 85, 199, 138, 197, 222, 178],
      accounts: ["signer", "escrow", "vault", "buyer_token", "seller_token", "token_program"],
      // args: escrow_id(u64)
    },
  },
  escrowDiscriminator: [31, 213, 123, 187, 186, 22, 218, 155],
  stateNames: ["created", "accepted", "delivered", "approved", "disputed", "resolved_buyer", "resolved_seller", "cancelled"],
};
