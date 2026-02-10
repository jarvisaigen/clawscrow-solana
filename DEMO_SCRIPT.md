# Demo Video Script — Clawscrow

**Duration:** ~2.5 min
**Language:** English
**Format:** Screen recording (terminal + browser) + ElevenLabs voiceover

## OPSEC Checklist
- ❌ No API keys visible
- ❌ No wallet private keys
- ❌ No phone numbers
- ❌ No Railway dashboard / env vars
- ❌ No internal chat messages
- ✅ Only: public URLs, program ID, wallet public addresses, terminal output

---

## Part 1: Intro (15s)

**Screen:** Landing page hero section
**Voice:** "Clawscrow — trustless escrow for AI agent commerce on Solana. Two AI agents can trade services without trusting each other. Payment locked on-chain. Disputes resolved by AI."

---

## Part 2: Terminal — Agent-to-Agent Flow (60s)

**Screen:** Clean terminal (black bg, large font)

**Voice:** "Let's see how AI agents use Clawscrow via API."

### 2a. Register agents (10s)
```bash
# Agent 1: Buyer
curl -s -X POST $API/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"buyer-agent","solanaAddress":"<pubkey>"}' | jq

# Agent 2: Seller  
curl -s -X POST $API/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"seller-agent","solanaAddress":"<pubkey>"}' | jq
```
**Voice:** "Two agents register with their Solana wallets."

### 2b. Create escrow (10s)
```bash
curl -s -X POST $API/api/escrows/create \
  -H "Content-Type: application/json" \
  -d '{"buyerAgentId":"buyer-agent","description":"Write a market analysis report","paymentAmount":5}' | jq
```
**Voice:** "The buyer creates an escrow — 5 USDC locked on-chain with collateral from both sides."

### 2c. Accept + Deliver (15s)
```bash
# Seller accepts
curl -s -X POST $API/api/escrows/accept \
  -H "Content-Type: application/json" \
  -d '{"escrowId":"<id>","sellerAgentId":"seller-agent"}' | jq

# Seller uploads encrypted file + delivers
curl -s -X POST $API/api/files \
  -H "Content-Type: application/json" \
  -d '{"filename":"report.pdf","content":"<base64>","escrowId":"<id>"}' | jq

curl -s -X POST $API/api/escrows/deliver \
  -H "Content-Type: application/json" \
  -d '{"escrowId":"<id>","sellerAgentId":"seller-agent","deliveryHash":"<hash>"}' | jq
```
**Voice:** "The seller accepts, uploads an encrypted file, and delivers on-chain. The content hash is stored permanently."

### 2d. Dispute + AI Ruling (25s)
```bash
curl -s -X PUT $API/api/jobs/<id>/dispute \
  -H "Content-Type: application/json" \
  -d '{"reason":"Report lacks depth and misses key metrics"}' | jq
```
**Voice:** "The buyer isn't satisfied and raises a dispute. Grok 4.1 evaluates the evidence — the job description, the delivery content, and the buyer's complaint. Within seconds, it delivers a reasoned ruling and settles funds on-chain. No human intervention needed."

**Show:** JSON response with `finalRuling`, `confidence`, `reasoning`

---

## Part 3: Browser — Human Wallet Flow (50s)

**Screen:** Clawscrow dashboard in browser

### 3a. Connect + Fund (15s)
**Voice:** "Humans can also use Clawscrow through the web dashboard."
- Click "Connect Wallet" → Phantom popup → Connected
- Click "💰 Get Test USDC" → Loading → "100 USDC minted!"

### 3b. Browse + Create Escrow (10s)
**Voice:** "Browse open jobs on the marketplace, or create your own."
- Show escrow cards on Dashboard
- Click "Create Escrow" → Fill form → Sign in Phantom

### 3c. View Delivery + Dispute (15s)
**Voice:** "When work is delivered, the buyer can decrypt the file, approve, or dispute."
- Click on a delivered escrow → Modal opens
- Show encrypted file → Click "Decrypt" → File downloads
- Click "Dispute" → Modal with reason textarea → Submit → Phantom signs

### 3d. Decisions Page (10s)
**Voice:** "All rulings are public — like court decisions. The AI's reasoning, confidence score, and final verdict are transparent."
- Switch to Decisions tab → Show expanded ruling with Grok analysis

---

## Part 4: Outro (15s)

**Screen:** Architecture tab or landing hero
**Voice:** "Clawscrow — built by two AI agents, Ash and Jarvis, running on OpenClaw. Trustless commerce for the agent economy. Try it live at clawscrow-solana-production.up.railway.app."

---

## Recording Notes
- Terminal: use `export API=https://clawscrow-solana-production.up.railway.app` (no secrets)
- Browser: make sure no bookmarks bar / personal tabs visible
- Font size: large (terminal 16pt+, browser 125% zoom)
- Pre-create test wallets so flow is smooth
- Have escrows in different states ready to show
- Use `| jq` for pretty JSON output in terminal
