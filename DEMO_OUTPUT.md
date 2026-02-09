# Clawscrow E2E Demo - Agent-to-Agent Escrow on Solana
**Date:** 2026-02-09T20:58:18.336Z
**Program:** `7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7`
**RPC:** http://127.0.0.1:8899

## Wallets
- **Buyer (Agent A):** `DLU8s3xj58wa4BFAqG6JyFAtGNjBo375NXCAjSKVMNSH`
- **Seller (Agent B):** `3sFJWcyiaJxCixvd24jj73W4KW4eBiQ6U6RoNEHFTtUU`
- **Arbitrator:** `85XybwPT63p8X31L6Y8F7anJG7aYjAtAcXNzDBDV3iyn`

## Funding
- Seller funded: 2 SOL
- Arbitrator funded: 1 SOL

## Token Setup
- **Test Token Mint:** `D9cRj4XTWXaq66Kxks99EfRu8MszCTNw9TeaQPZSBYeP`
- Buyer ATA: `UUEsMEiTF48ej3XBqccjmEMfKgULm4o9HwEgSNiRhX3` — minted 150 tokens
- Seller ATA: `GMCKWKj9K6NxVNaAUqCT8KnmWCtz14JWZBkbrDsknZ12` — minted 25 tokens

## Escrow PDAs
- **Escrow ID:** 1770670701672
- **Escrow PDA:** `kueP4DVuoR2ruwvz2EyUsAsPBmQZgvqMUhccYP3Lz8Z`
- **Vault PDA:** `EPG4McP1AXWqVHUmvrbyzVpnq1HiCXNKazdPTzSRMtDY`

## Step 1: Create Escrow (Buyer)
✅ TX: `32ZinuMUhd8EHu6A9US4sZymGe2cWJ6v6BtB7MgNJVcJCrpLdoiZuhkaePJUR1DQyuGwXm7eBFH3hm26Q2BTSGQm`
   https://explorer.solana.com/tx/32ZinuMUhd8EHu6A9US4sZymGe2cWJ6v6BtB7MgNJVcJCrpLdoiZuhkaePJUR1DQyuGwXm7eBFH3hm26Q2BTSGQm?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899

## Step 2: Accept Escrow (Seller)
✅ TX: `4nmPqYmLMJaW7SSZpPMf55ySthnLzW94damkRjR2yt9oBCNVxDAG9CLWRbMrmRv1BHkFw5KHhkk5rTLCR8UED3Bm`
   https://explorer.solana.com/tx/4nmPqYmLMJaW7SSZpPMf55ySthnLzW94damkRjR2yt9oBCNVxDAG9CLWRbMrmRv1BHkFw5KHhkk5rTLCR8UED3Bm?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899

## Step 3: Deliver Work (Seller)
✅ TX: `4YKFXhJxvu3daErBZ9Dt1G1rjihcaC2PG8qUsx2jDjtBfeaApx1i7TUz5YJpmsLiGHQC9fBGeZfYobE8as1wq4SJ`
   https://explorer.solana.com/tx/4YKFXhJxvu3daErBZ9Dt1G1rjihcaC2PG8qUsx2jDjtBfeaApx1i7TUz5YJpmsLiGHQC9fBGeZfYobE8as1wq4SJ?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899

## Step 4: Approve & Release Funds (Buyer)
✅ TX: `58ZTAfyLRHxSdrQCsjAZfqx1KHnb8qNGRCfWABamQaapD8AAQLvi9gxLLeWisWMeuitkmPRu4LnBdBTQguzLzodx`
   https://explorer.solana.com/tx/58ZTAfyLRHxSdrQCsjAZfqx1KHnb8qNGRCfWABamQaapD8AAQLvi9gxLLeWisWMeuitkmPRu4LnBdBTQguzLzodx?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899

## Final Escrow State
- **Escrow ID:** 1770670701672
- **Account size:** 699 bytes
- **Raw state check:** Account exists and funded

## Transaction Summary
- **create_escrow:** `32ZinuMUhd8EHu6A9US4sZymGe2cWJ6v6BtB7MgNJVcJCrpLdoiZuhkaePJUR1DQyuGwXm7eBFH3hm26Q2BTSGQm`
  https://explorer.solana.com/tx/32ZinuMUhd8EHu6A9US4sZymGe2cWJ6v6BtB7MgNJVcJCrpLdoiZuhkaePJUR1DQyuGwXm7eBFH3hm26Q2BTSGQm?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899
- **accept_escrow:** `4nmPqYmLMJaW7SSZpPMf55ySthnLzW94damkRjR2yt9oBCNVxDAG9CLWRbMrmRv1BHkFw5KHhkk5rTLCR8UED3Bm`
  https://explorer.solana.com/tx/4nmPqYmLMJaW7SSZpPMf55ySthnLzW94damkRjR2yt9oBCNVxDAG9CLWRbMrmRv1BHkFw5KHhkk5rTLCR8UED3Bm?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899
- **deliver:** `4YKFXhJxvu3daErBZ9Dt1G1rjihcaC2PG8qUsx2jDjtBfeaApx1i7TUz5YJpmsLiGHQC9fBGeZfYobE8as1wq4SJ`
  https://explorer.solana.com/tx/4YKFXhJxvu3daErBZ9Dt1G1rjihcaC2PG8qUsx2jDjtBfeaApx1i7TUz5YJpmsLiGHQC9fBGeZfYobE8as1wq4SJ?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899
- **approve:** `58ZTAfyLRHxSdrQCsjAZfqx1KHnb8qNGRCfWABamQaapD8AAQLvi9gxLLeWisWMeuitkmPRu4LnBdBTQguzLzodx`
  https://explorer.solana.com/tx/58ZTAfyLRHxSdrQCsjAZfqx1KHnb8qNGRCfWABamQaapD8AAQLvi9gxLLeWisWMeuitkmPRu4LnBdBTQguzLzodx?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899

🎉 **Full escrow lifecycle completed on Solana!**