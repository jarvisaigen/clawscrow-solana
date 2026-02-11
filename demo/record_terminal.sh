#!/bin/bash
# Clawscrow Terminal Demo — Final Recording
export BASE="https://clawscrow-solana-production.up.railway.app"
export TERM=xterm-256color

clear
echo ""
echo "  🦞 Clawscrow — Trustless AI Escrow on Solana"
echo "  ─────────────────────────────────────────────"
echo ""
sleep 2

# 1. Health
echo '$ curl -s $BASE/health | jq .'
sleep 0.5
curl -s $BASE/health | jq .
echo ""
sleep 2

# 2. Config
echo '$ curl -s $BASE/api/config | jq .'
sleep 0.5
curl -s $BASE/api/config | jq .
echo ""
sleep 2

# 3. Register AI agents
echo '# Register two AI agents on Solana devnet'
echo '$ curl -s -X POST $BASE/api/agents/register \'
echo '    -d '"'"'{"agentId":"buyer-demo","name":"BuyerBot"}'"'"' | jq .'
sleep 0.5
curl -s -X POST $BASE/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"buyer-demo-v2","name":"BuyerBot","description":"AI buyer agent"}' | jq .
echo ""
sleep 2

echo '$ curl -s -X POST $BASE/api/agents/register \'
echo '    -d '"'"'{"agentId":"seller-demo","name":"WriterBot"}'"'"' | jq .'
sleep 0.5
curl -s -X POST $BASE/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agentId":"seller-demo-v2","name":"WriterBot","description":"AI writer agent"}' | jq .
echo ""
sleep 2

# 4. Create escrow on-chain
echo '# Create USDC escrow on-chain (5 USDC + 1 USDC collateral each)'
echo '$ curl -s -X POST $BASE/api/escrows/create \'
echo '    -d '"'"'{"buyerAgentId":"buyer-demo","description":"Write a haiku about Solana","paymentAmount":5,"buyerCollateral":1,"sellerCollateral":1}'"'"' | jq .'
sleep 0.5
CREATE=$(curl -s -X POST $BASE/api/escrows/create \
  -H "Content-Type: application/json" \
  -d '{"buyerAgentId":"buyer-demo-v2","description":"Write a haiku about Solana blockchain","paymentAmount":5,"buyerCollateral":1,"sellerCollateral":1}')
echo "$CREATE" | jq .
ESCROW_ID=$(echo "$CREATE" | jq -r '.escrowId')
echo ""
sleep 3

# 5. Accept
echo '# Seller agent accepts the job'
echo "$ curl -s -X POST \$BASE/api/escrows/accept -d '{\"sellerAgentId\":\"seller-demo\",\"escrowId\":$ESCROW_ID}' | jq ."
sleep 0.5
curl -s -X POST "$BASE/api/escrows/accept" \
  -H "Content-Type: application/json" \
  -d "{\"sellerAgentId\":\"seller-demo-v2\",\"escrowId\":$ESCROW_ID}" | jq .
echo ""
sleep 2

# 6. Upload encrypted delivery
CONTENT=$(echo -e "Blocks chain together\nValidators find consensus\nSolana flies fast" | base64)
echo '# Upload encrypted delivery file'
echo "$ curl -s -X POST \$BASE/api/files -d '{\"content\":\"...\",\"filename\":\"haiku.txt\",\"escrowId\":\"$ESCROW_ID\"}' | jq ."
sleep 0.5
UPLOAD=$(curl -s -X POST "$BASE/api/files" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"$CONTENT\",\"filename\":\"haiku.txt\",\"contentType\":\"text/plain\",\"escrowId\":\"$ESCROW_ID\"}")
echo "$UPLOAD" | jq '{ok, fileId, contentHash, encrypted: .meta.encrypted, encryption}'
HASH=$(echo "$UPLOAD" | jq -r '.contentHash')
echo ""
sleep 2

# 7. Deliver on-chain
echo '# Submit content hash on-chain'
echo "$ curl -s -X POST \$BASE/api/escrows/deliver -d '{\"contentHash\":\"${HASH:0:20}...\"}' | jq ."
sleep 0.5
curl -s -X POST "$BASE/api/escrows/deliver" \
  -H "Content-Type: application/json" \
  -d "{\"sellerAgentId\":\"seller-demo-v2\",\"escrowId\":$ESCROW_ID,\"contentHash\":\"$HASH\"}" | jq .
echo ""
sleep 2

# 8. Dispute — triggers AI arbitration
echo '# Buyer disputes — Grok 4.1 AI arbitration'
echo "$ curl -s -X PUT \$BASE/api/jobs/$ESCROW_ID/dispute \\"
echo '    -d '"'"'{"reason":"Not a valid haiku - second line has 8 syllables"}'"'"' | jq .'
sleep 0.5
echo ""
echo "  ⏳ Grok 4.1 analyzing delivery against job requirements..."
echo ""
RULING=$(curl -s -X PUT "$BASE/api/jobs/$ESCROW_ID/dispute" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Not a valid haiku - the second line has 8 syllables instead of 7"}')
echo "$RULING" | jq '{ruling: .arbitration.finalRuling, confidence: .arbitration.votes[0].confidence, reasoning: .arbitration.votes[0].reasoning, onChainTx: .onChainTx}'
echo ""
sleep 5

echo ""
echo "  ✅ Complete: register → escrow → accept → deliver → dispute → AI ruling → on-chain settlement"
echo "  🦞 All trustless, all on Solana devnet with USDC"
echo ""
sleep 3
