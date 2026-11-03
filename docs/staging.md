# Staging (Railway, Base Sepolia)

Staging runs the production configuration (`NODE_ENV=production`) on **Base Sepolia test money**.
It is defined in [`.railway/railway.ts`](../.railway/railway.ts), which refuses to plan or apply to
any environment other than `staging`.

| Service | Role | Network | Health check |
|---|---|---|---|
| `@mx/gateway` | API: billing, settlement, ledger, products (maritime simulated, grid live) | public domain + private `mxgateway.railway.internal:8080` | `/readyz` |
| `facilitator` | Self-hosted x402 facilitator, the gateway's **fallback** (primary: x402.org) | private only, `facilitator.railway.internal:8090` | `/healthz` |
| `reconciler` | Ledger against chain every 15 min; alerts on persistent mismatches | private only | `/healthz` |
| `postgres` | Railway-managed Postgres | private | (managed) |

Deploys come from `main`, only after CI passes (`checkSuites`). A service redeploys only when its own
code, a shared package, the schema or the Dockerfile changes.

## Secrets

The config file holds no secret values. Three secrets are set out of band; other services
reference them rather than copying them:

| Variable | Service | Referenced by |
|---|---|---|
| `ADMIN_TOKEN` | `@mx/gateway` | `reconciler.ADMIN_TOKEN` |
| `AUTH_TOKEN` | `facilitator` | `@mx/gateway.FALLBACK_FACILITATOR_AUTH_TOKEN` |
| `FACILITATOR_PRIVATE_KEY` | `facilitator` | (only the facilitator) |

The staging wallet keys live in the operator's macOS Keychain (`pnpm staging:wallets`):

| Keychain item | Address | Purpose |
|---|---|---|
| `x402-staging-pay-to` | `0x35E13c683A70fBe048CDB897cE1bAe36440fcd19` | payee (receive-only) |
| `x402-staging-facilitator` | `0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5` | facilitator gas wallet |

Never use `ctx.randomString` in `.railway/railway.ts` for secrets: it is a deterministic hash of the
environment name and a label, so anyone can compute it.

## First-time setup

Run from the repo root on the operator's machine (Railway CLI 5.x, linked with `railway link` to
project `authentic-rebirth`, environment `staging`).

1. **Merge to `main`** the PR that adds this file, so Railway builds the code it describes.
2. **Apply the infrastructure.** Review the plan first:
   ```bash
   railway config plan
   railway config apply
   ```
3. **Set the secrets.** Values are generated locally, piped over stdin, and never printed:
   ```bash
   openssl rand -hex 32 | railway variable set ADMIN_TOKEN --stdin -s @mx/gateway --skip-deploys
   openssl rand -hex 32 | railway variable set AUTH_TOKEN --stdin -s facilitator --skip-deploys
   security find-generic-password -s x402-staging-facilitator -a x402 -w \
     | railway variable set FACILITATOR_PRIVATE_KEY --stdin -s facilitator --skip-deploys
   ```
   Then **seal** all three in the Railway dashboard (Variables, then the ⋯ menu, then Seal): a sealed
   value can be used by deploys but never read back. To read the admin token later, rotate it instead.
4. **Give the gateway a public domain:** `railway domain -s @mx/gateway`.
5. **Fund the facilitator gas wallet** `0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5` with a little
   Base Sepolia ETH from a faucet. It needs only gas; it never holds customer funds. Until it is funded
   the facilitator deploys and serves `/healthz`, but its `/readyz` reports `gas: false` and it cannot
   settle, so the gateway uses the x402.org primary.
6. **Redeploy:** `railway redeploy -s facilitator`, then `-s @mx/gateway`, then `-s reconciler`.

## Checks

```bash
curl https://<gateway-domain>/readyz       # {"ok":true,"db":true,"products":{"maritime":true,"grid":true},…}
curl https://<gateway-domain>/v1/products  # maritime and grid
railway logs -s reconciler                 # one JSON line per run: "ok":true
```

Pay end to end with test USDC from https://faucet.circle.com (Base Sepolia):

```bash
GATEWAY_URL=https://<gateway-domain> WALLET_PRIVATE_KEY=<a Base Sepolia test wallet> pnpm demo:agent
```

## Operations

- **Reconciliation alert.** The reconciler logs `"level":"error"` with `persistent` problems, which
  were seen in two consecutive runs. A single-run problem is usually a settlement in flight. Set
  `RECONCILE_ALERT_WEBHOOK_URL` (e.g. a Slack incoming webhook) in the file to be paged.
- **Facilitator gas.** Watch `facilitator_gas_balance_wei` on `/metrics` (private) or `/readyz`.
- **Rotating a secret.** Set the new value as in step 3, then redeploy the owner and every service
  that references it.
- **Production** is a separate environment and is deliberately not described by this file.
