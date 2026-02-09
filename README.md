# Clawscrow — Trustless Escrow Protocol on Solana

<p align="center">
  <strong>Decentralized escrow for freelance work, powered by dual collateral and automated dispute resolution.</strong>
</p>

## Overview

Clawscrow is a trustless escrow protocol built on Solana using Anchor. It enables secure freelance transactions where both buyer and seller have skin in the game through dual collateral deposits, with optional arbitration for disputes.

**Program ID:** `7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7`

## How It Works

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   Open   │────▶│  Active  │────▶│Delivered │────▶│ Approved │
│          │     │          │     │          │     │          │
│  Buyer   │     │  Seller  │     │  Seller  │     │  Buyer   │
│  creates │     │  accepts │     │ delivers │     │ approves │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                       │
                                       ▼
                                  ┌──────────┐     ┌──────────┐
                                  │Disputed  │────▶│ Resolved │
                                  │          │     │          │
                                  │  Buyer   │     │Arbitrator│
                                  │ disputes │     │ decides  │
                                  └──────────┘     └──────────┘
```

### Escrow Lifecycle

1. **Create** — Buyer posts a job, depositing payment + collateral (USDC) into an on-chain vault PDA
2. **Accept** — Seller accepts the job, depositing their own matching collateral
3. **Deliver** — Seller submits work (content hash stored on-chain for verification)
4. **Approve** — Buyer approves delivery → Seller receives payment + both collaterals back
   - *Auto-approve after 3 days if buyer doesn't respond*
5. **Dispute** — Buyer can raise a dispute within the 3-day review period
6. **Arbitrate** — Designated arbitrator decides the winner, who receives payment + both collaterals (minus 1% protocol fee)

### Key Design Decisions

- **Dual Collateral**: Both parties deposit collateral, creating aligned incentives for honest behavior
- **Auto-Approve**: Prevents buyer from indefinitely holding seller's funds
- **On-Chain Content Hashing**: Delivery proofs are verifiable without storing content on-chain
- **1% Protocol Fee**: Only charged on disputed escrows resolved by arbitrator

## Architecture

| Component | Description |
|-----------|-------------|
| `Escrow` PDA | Stores escrow state, participants, amounts, and hashes |
| `Vault` PDA | SPL Token account holding all locked funds |
| SPL Token | USDC (or any SPL token) for payments and collateral |

### Account Seeds

- Escrow: `["escrow", escrow_id (u64 LE)]`
- Vault: `["vault", escrow_id (u64 LE)]`

## Tech Stack

- **Solana** — High-throughput L1 blockchain
- **Anchor** — Solana smart contract framework (v0.29)
- **SPL Token** — Standard token interface for USDC
- **TypeScript** — Test suite and frontend

## Project Structure

```
├── programs/clawscrow/src/lib.rs   # Anchor smart contract
├── tests/clawscrow.ts              # Full test suite
├── target/idl/clawscrow.json       # IDL for client generation
├── public/                         # Frontend application
│   ├── index.html
│   ├── css/
│   └── js/
├── Anchor.toml                     # Anchor configuration
└── Cargo.toml                      # Rust workspace
```

## Getting Started

### Prerequisites

- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) v1.17+
- [Anchor](https://www.anchor-lang.com/docs/installation) v0.29+
- [Node.js](https://nodejs.org/) v18+

### Build & Test

```bash
# Install dependencies
yarn install

# Build the program
anchor build

# Run tests (starts local validator automatically)
anchor test
```

### Deploy to Devnet

```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Frontend

The `public/` directory contains a web frontend for interacting with the escrow protocol. It connects to Solana devnet via wallet adapters (Phantom, Solflare).

## Security Considerations

- All state transitions are validated with explicit guards
- PDA seeds prevent escrow ID collisions
- Token authority is the vault PDA itself (no admin keys)
- Collateral amounts enforced at creation time
- Auto-approve window protects seller from unresponsive buyers

## License

MIT

---

*Built for the Solana ecosystem. Part of the Clawscrow protocol suite.*
