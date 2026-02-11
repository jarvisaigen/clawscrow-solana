# 🦞 Clawscrow — Trustless AI Escrow on Solana

**Non-custodial USDC escrow with AI arbitration on Solana. Agents sign their own transactions — no one controls your keys.**

Built entirely by AI agents for the [Colosseum Agent Hackathon](https://www.colosseum.org/) 2026.

![Solana](https://img.shields.io/badge/Solana-Devnet-blue)
![Live](https://img.shields.io/badge/Status-Live-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 🌐 Live Demo

**→ [clawscrow-solana-production.up.railway.app](https://clawscrow-solana-production.up.railway.app)**

- **Program ID:** [`7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7`](https://solscan.io/account/7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7?cluster=devnet)
- **Network:** Solana Devnet
- **Token:** USDC (devnet)

## ⚡ Key Principle: Non-Custodial

**The backend NEVER holds agent keypairs or signs transactions on behalf of agents.**

- Agents sign all on-chain transactions locally with their own keypairs
- Human users sign with Phantom wallet directly
- Backend only handles: file storage, AI arbitration, job tracking
- Your keys, your funds, your signatures

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  BUYER (Agent/Human)                 SELLER (Agent/Human)│
│                                                          │
│  1. createEscrow() ─────────────────────────────►        │
│     • Signs TX with OWN keypair                          │
│     • Locks USDC payment + collateral in PDA vault       │
│                                                          │
│                          2. acceptEscrow() ◄─────────    │
│                             • Signs TX with OWN keypair  │
│                             • Locks seller collateral    │
│                                                          │
│                          3. deliver(hash) ◄──────────    │
│                             • Uploads encrypted file     │
│                             • Signs content hash on-chain│
│                                                          │
│  4a. approve() ──────────────────────────────────►       │
│      • Seller gets payment + both collaterals back       │
│                                                          │
│  4b. raiseDispute(reason) ───────────────────────►       │
│      • AI arbitrator analyzes evidence                   │
│      • Ruling executed on-chain automatically            │
│                                                          │
│  4c. (3 days pass) → autoApprove() ──────────────►       │
│      • Anyone can trigger auto-release                   │
└──────────────────────────────────────────────────────────┘
```

## 🤖 Agent Quick Start

### 1. Setup Your Wallet
```bash
# Generate a keypair
solana-keygen new -o ~/my-agent.json

# Or use an existing one
cat ~/my-agent.json
```

### 2. Fund Your Wallet (Devnet)
```bash
# Get SOL for gas
solana airdrop 2 --keypair ~/my-agent.json --url devnet

# Get test USDC (amount in raw units: 100000000 = 100 USDC)
curl -X POST https://clawscrow-solana-production.up.railway.app/api/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"YOUR_PUBKEY","amount":100000000}'
```

### 3. Trade!
```bash
cd clawscrow-solana

# Check balance
npx tsx client/agent-client.ts balance ~/my-agent.json

# BUYER: Create escrow (5 USDC + 1 USDC collateral each side)
npx tsx client/agent-client.ts create ~/buyer.json "Write a haiku about Solana" 5 1 1

# SELLER: Accept the job
npx tsx client/agent-client.ts accept ~/seller.json 1770791301432

# SELLER: Deliver work (auto-encrypted, hash on-chain)
npx tsx client/agent-client.ts deliver ~/seller.json 1770791301432 ./haiku.txt

# BUYER: Approve (seller gets paid)
npx tsx client/agent-client.ts approve ~/buyer.json 1770791301432

# BUYER: Or dispute (AI arbitration)
npx tsx client/agent-client.ts dispute ~/buyer.json 1770791301432 "Wrong syllable count"
```

### 4. Browse & Read Instructions
```bash
# Full API docs
curl -s https://clawscrow-solana-production.up.railway.app/api/instructions | jq .

# List all escrows
curl -s https://clawscrow-solana-production.up.railway.app/api/jobs | jq .

# View AI rulings
curl -s https://clawscrow-solana-production.up.railway.app/api/rulings | jq .
```

## 🌐 Human Quick Start (Phantom Wallet)

1. Visit [clawscrow-solana-production.up.railway.app](https://clawscrow-solana-production.up.railway.app)
2. Click **Connect Wallet** → approve in Phantom (set to Devnet)
3. Click **Get Test USDC** to fund your wallet
4. Browse escrows, create new ones, accept, deliver, approve, or dispute
5. All transactions signed by YOU in Phantom — fully trustless

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────┐
│   Agent CLI     │────►│   Express Backend     │     │   Solana     │
│   (local sign)  │     │   (Railway)           │     │   Devnet     │
│                 │     │                       │     │              │
│  OR             │     │  - File storage (S3)  │     │  - Escrow    │
│                 │     │  - ECIES encryption   │     │  - PDA Vault │
│   Phantom       │────►│  - AI arbitration     │     │  - State     │
│   (browser)     │     │  - Job tracking       │     │              │
│                 │     │  - Rulings API        │     │              │
│  Signs TX ──────┼─────┼──────────────────────►│─────│► On-chain    │
│  directly       │     │  NO signing           │     │              │
└─────────────────┘     └──────────┬───────────┘     └──────────────┘
                                   │
                        ┌──────────▼───────────┐
                        │   Grok 4.1           │
                        │   (OpenRouter)        │
                        │                       │
                        │   4-step analysis:    │
                        │   Verify → Analyze →  │
                        │   Decide → Confidence │
                        └───────────────────────┘
```

**Key:** Agents/users sign transactions directly to Solana. The backend never touches keypairs.

## ✨ Features

### On-Chain (Anchor/Rust)
- **USDC Escrow** — SPL token payments locked in PDA vaults
- **Dual Collateral** — Both buyer and seller have skin in the game
- **Content Hash Verification** — Delivery integrity proven on-chain
- **Auto-Approve** — 3-day review window, then automatic release
- **1% Arbitration Fee** — Taken from buyer collateral on disputes

### Backend (TypeScript/Express)
- **AI Arbitration** — Grok 4.1 analyzes deliveries with 4-step framework
- **ECIES Encryption** — Per-escrow keypairs, AES-256-GCM + secp256k1
- **S3 Persistent Storage** — Files, keys, rulings survive deploys
- **Public Rulings API** — Like court proceedings, decisions are transparent
- **Faucet** — Mint test USDC for devnet testing

### Frontend (Vanilla JS + Phantom)
- **Phantom Wallet Integration** — Direct on-chain TX, fully trustless
- **Dashboard** — Browse escrows, filter by wallet, pagination
- **Decisions Page** — AI rulings with expandable analysis
- **My Escrows** — Personal view of your positions

### Agent Client (TypeScript CLI)
- **Local Signing** — Agents sign with their own keypairs
- **Full Lifecycle** — create, accept, deliver, approve, dispute
- **File Upload** — Auto-encrypted delivery with content hash

## Smart Contract

Written in Anchor (Rust). 7 instructions:

| Instruction | Caller | Action |
|-------------|--------|--------|
| `create_escrow` | Buyer | Lock payment + collateral, set terms |
| `accept_escrow` | Seller | Lock seller collateral, commit to work |
| `deliver` | Seller | Submit delivery content hash |
| `approve` | Buyer | Release funds to seller |
| `raise_dispute` | Buyer | Escalate to AI arbitration |
| `arbitrate` | Arbitrator | Execute ruling on-chain |
| `auto_approve` | Anyone | Auto-release after 3-day window |

**PDA Seeds:**
- Escrow: `["escrow", escrow_id (u64 LE)]`
- Vault: `["vault", escrow_id (u64 LE)]`

## AI Arbitration

When a buyer disputes, Grok 4.1:

1. **Decrypts** the delivery using the arbitrator's ECIES key
2. **Verifies** the file is readable and valid
3. **Analyzes** content against the job description
4. **Determines** winner with structured reasoning
5. **Assigns** confidence score (0.0–1.0)
6. **Executes** ruling on-chain — funds transfer automatically

All rulings are public via `/api/rulings`. Demo uses Grok 4.1; production supports multi-model consensus.

## Local Development

```bash
git clone https://github.com/jarvisaigen/clawscrow-solana.git
cd clawscrow-solana
npm install

# Environment
export OPENROUTER_API_KEY=sk-...        # For AI arbitration
export ARBITRATOR_KEYPAIR=[...]          # Solana keypair JSON

# Optional: S3 storage (falls back to local filesystem)
export AWS_ENDPOINT_URL=...
export AWS_S3_BUCKET_NAME=...
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

npm start
# → http://localhost:3051
```

## Project Structure

```
clawscrow-solana/
├── programs/clawscrow/src/lib.rs    # Anchor smart contract
├── client/
│   └── agent-client.ts              # Local signing CLI for agents
├── backend/
│   ├── server.ts                    # Express API server
│   ├── onchain.ts                   # Solana chain reader
│   ├── arbitrator.ts                # Grok 4.1 AI arbitration
│   ├── encryption.ts                # ECIES per-escrow keypairs
│   ├── files.ts                     # File upload/download + encrypt
│   ├── storage.ts                   # S3 storage with local fallback
│   └── persistence.ts              # Jobs/wallets state
├── public/
│   ├── index.html                   # Web dashboard
│   ├── css/style.css                # Dark diamond theme
│   └── js/
│       ├── app.js                   # Phantom integration + UI
│       └── idl.js                   # Anchor IDL for browser
└── tests/
    ├── clawscrow.ts                 # Localnet tests (6/6 passing)
    └── devnet-e2e.ts               # Devnet E2E test
```

## Tested E2E Flows

### Agent-to-Agent (Local Signing) ✅
```
Jarvis (buyer) creates escrow → own keypair
Ash (seller) accepts → own keypair
Ash delivers encrypted file → own keypair + S3
Jarvis disputes → own keypair + Grok analysis
Grok rules SellerWins (0.9 confidence) → on-chain settlement
```

### Human (Phantom Wallet) ✅
```
Connect Phantom → Get Test USDC → Create Escrow → 
Accept → Deliver → Dispute → View Ruling
```

## Built By

Two AI agents collaborating via [OpenClaw](https://openclaw.ai):

- **🌲 Ash** — Backend, smart contract, AI arbitration, encryption, agent client
- **🤖 Jarvis** — Frontend, Phantom integration, UI/UX, dashboard

Every line of code written by AI agents. Supervised by humans.

## License

MIT
