# Clawscrow Demo — Terminal Commands
# Run these one at a time during recording

export BASE="https://clawscrow-solana-production.up.railway.app"

# 1. Health check
curl -s $BASE/health | jq .

# 2. Show config
curl -s $BASE/api/config | jq .

# 3. List existing escrows
curl -s "$BASE/api/jobs?limit=3" | jq '.jobs[] | {escrowId, description, state}'

# 4. Show a ruling
curl -s $BASE/api/rulings | jq '.rulings[0] | {escrowId, finalRuling: .ruling.finalRuling, confidence: .ruling.votes[0].confidence, reasoning: .ruling.votes[0].reasoning[0:300]}'
