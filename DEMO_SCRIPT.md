# 🎬 Clawscrow Demo Video Script

**Duration:** ~3 minutes
**Language:** English
**Format:** Screen recording (terminal + browser) + ElevenLabs voiceover
**Resolution:** 1920x1080

---

## OPSEC CHECKLIST (verify before recording!)
- [ ] No API keys visible (env vars, .env files)
- [ ] No private keys or wallet seeds
- [ ] No GitHub tokens
- [ ] No phone numbers or personal messages
- [ ] No Railway dashboard / env vars
- [ ] Terminal history cleared (`history -c && clear`)
- [ ] Browser: only Clawscrow tab open, no bookmarks bar
- [ ] No other apps visible in dock/taskbar
- [ ] Notifications disabled

---

## Part 1: Intro (15s)

**Screen:** Clawscrow landing page

**Voiceover:**
> "Clawscrow — trustless USDC escrow with AI arbitration on Solana. Two AI agents can trade services without trusting each other. Payment is locked on-chain. Disputes are resolved by an AI judge. Built entirely by AI agents."

---

## Part 2: Terminal — Agent-to-Agent Flow (60s)

**Screen:** Clean terminal, dark theme, large font

**Setup before recording:**
```bash
history -c && clear
export PS1="$ "
export BASE="https://clawscrow-solana-production.up.railway.app"
```

### 2a. Health check (5s)
```bash
curl -s $BASE/health | jq .
```
> "The backend runs on Railway with S3-persistent storage on Solana devnet."

### 2b. Create escrow (15s)
```bash
curl -s -X POST $BASE/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Write a haiku about Solana blockchain",
    "amount": 5,
    "collateral": 0.5,
    "deadline": "2026-02-15",
    "buyer": "BUYER_WALLET_ADDRESS"
  }' | jq .
```
> "Agent A creates an escrow — 5 USDC locked on-chain with collateral from both parties."

### 2c. Accept + Deliver (15s)
```bash
curl -s -X PUT $BASE/api/jobs/ESCROW_ID/accept \
  -H "Content-Type: application/json" \
  -d '{"seller": "SELLER_WALLET_ADDRESS"}' | jq .
```
```bash
curl -s -X POST $BASE/api/files/upload \
  -H "Content-Type: application/json" \
  -d '{"content": "BASE64_CONTENT", "filename": "haiku.txt", "escrowId": "ESCROW_ID"}' | jq .
```
> "Agent B accepts and delivers. The file is automatically encrypted with per-escrow ECIES keys — the server cannot read the content."

### 2d. Dispute + AI Ruling (25s)
```bash
curl -s -X PUT $BASE/api/jobs/ESCROW_ID/dispute \
  -H "Content-Type: application/json" \
  -d '{"reason": "Not a proper haiku - wrong syllable count"}' | jq .
```
> "Agent A disputes. Grok 4.1 decrypts the delivery, analyzes it against the job description, and determines a winner with a confidence score. The ruling is executed on-chain automatically — funds transfer to the winner."

**Show:** Grok's reasoning in the JSON response — pause so viewers can read.

---

## Part 3: Web UI — Phantom Wallet Flow (60s)

**Screen:** Browser at clawscrow-solana-production.up.railway.app

> "Clawscrow also has a web dashboard for human users with Phantom wallet integration."

### 3a. Connect Phantom (10s)
- Click "Connect Wallet" → Phantom popup → approve
> "Connect your Phantom wallet. All transactions are signed by you — fully trustless, no custody."

### 3b. Get Test USDC (10s)
- Click "Get Test USDC" → loading spinner → success toast
> "New users can mint devnet USDC with one click to start testing."

### 3c. Browse Escrows (10s)
- Show Escrows tab with list of jobs
- Click on an escrow to see details
> "Browse all escrows on the marketplace. Filter by wallet, paginate through results."

### 3d. My Escrows (10s)
- Switch to "My Escrows" tab
- Show personal view
> "Your personal dashboard shows escrows you've created or accepted."

### 3e. Decisions Page (15s)
- Switch to "Decisions" tab
- Click on a ruling to expand full analysis
> "Every dispute ruling is public — like court proceedings. Click to see the AI judge's full analysis, evidence review, and confidence score. The on-chain transaction is linked."

### 3f. Create New Escrow (5s)
- Click "Create Escrow" → show modal
> "Creating a new escrow takes seconds."

---

## Part 4: Architecture + Closing (30s)

**Screen:** Architecture diagram or README

> "Under the hood: an Anchor smart contract locks USDC in PDA vaults on Solana. ECIES encryption protects all deliveries end-to-end. Grok 4.1 provides AI arbitration with structured four-step reasoning. All state persists in S3 storage."

> "Clawscrow was built entirely by two AI agents — Ash and Jarvis — running on OpenClaw, supervised by their human team. Every line of code, every commit, every design decision — made by AI agents collaborating in real-time. This is agent commerce, built by agents, for agents."

**End card:** GitHub URL + "Colosseum Agent Hackathon 2026"

---

## Recording Checklist

### Terminal
- Black background, large monospace font (16pt+)
- Simple prompt: `$ `
- Pre-test all commands work before recording
- Use fresh escrow created live during recording

### Browser
- Clean profile or incognito
- Only Clawscrow tab, no bookmarks bar
- Phantom on devnet, pre-funded with test USDC
- Disable all notifications

### Post-Production
- Title cards between Part 2 and Part 3
- Subtle background music (royalty-free)
- ElevenLabs voiceover synced to actions
- Combine with ffmpeg
