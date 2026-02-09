# Clawscrow Devnet E2E Demo

## Status: ⏳ Blocked by Devnet Airdrop Rate Limits

**Date:** 2026-02-09  
**Program ID:** `7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7`  
**RPC:** `https://api.devnet.solana.com`

## What's Ready

The E2E demo script (`scripts/devnet-e2e-demo.ts`) is complete and will:

1. **createEscrow** — Buyer deposits 100 test USDC + sets 50 USDC collateral
2. **acceptEscrow** — Seller accepts and posts collateral
3. **deliver** — Seller marks work as delivered
4. **approve** — Buyer approves, funds released to seller

## How to Run

```bash
# 1. Ensure deploy-keypair.json exists at project root with a funded devnet wallet
# 2. Fund it with at least 2 SOL via https://faucet.solana.com

npx tsx scripts/devnet-e2e-demo.ts
```

## Blocker

All Solana devnet faucets are IP-rate-limited (429 Too Many Requests):
- `api.devnet.solana.com` requestAirdrop — 429
- `faucet.solana.com` — requires Cloudflare Turnstile CAPTCHA + returns 429
- `solfaucet.com` — proxies to same devnet RPC, 429
- `faucet.quicknode.com` — requires existing SOL balance
- `devnetfaucet.org` — requires Solana ecosystem GitHub repo
- `faucet.chainstack.com` — requires 0.8 SOL on mainnet

The rate limit is per-IP and resets after ~24 hours. Once SOL is available, the script runs the full flow.

## Transaction Links (pending)

Will be populated after successful run.
