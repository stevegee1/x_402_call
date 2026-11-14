# Staging (Railway, Base Sepolia)

Staging runs the production configuration (`NODE_ENV=production`) on **Base Sepolia test money**.
It is defined in [`.railway/railway.ts`](../.railway/railway.ts), which refuses to plan or apply to
any environment other than `staging`.

| Service | Role | Network | Health check |
|---|---|---|---|
| `@mx/gateway` | API: billing, settlement, ledger, products (maritime from live AIS, grid live) | public domain + private `mxgateway.railway.internal:8080` | `/readyz` |
| `facilitator` | Self-hosted x402 facilitator, the gateway's **fallback** (primary: x402.org) | private only, `facilitator.railway.internal:8090` | `/healthz` |
| `reconciler` | Ledger against chain every 15 min; alerts on persistent mismatches | private only | `/healthz` |
| `gas-keeper` | Keeps the facilitator's gas wallet funded from a USDC float ([gas-keeper.md](gas-keeper.md)) | private only, `gas-keeper.railway.internal:8093` | `/healthz` |
| `ingest-env` | Stores every published NESO version (point-in-time history); exits until the gateway has migrated | private only, `ingest-env.railway.internal:8091` | `/healthz` |
| `ingest` | Live AIS from AISStream onto the bus, and position history (30 days) into Postgres | private only, `ingest.railway.internal:8092` | `/healthz` |
| `nats` | AIS bus (`nats:2.10.29-alpine`, no persistence); ingest publishes, the gateway subscribes | private only, `nats.railway.internal:4222` | (none) |
| `postgres` | Railway-managed Postgres | private | (managed) |

Deploys come from the branch named by `STAGING_BRANCH` in the config file (`feat/staging-railway`
until its PR merges, then `main`), waiting for CI checks where the branch has them (`checkSuites`). A service redeploys only when its own
code, a shared package, the schema or the Dockerfile changes.

## Secrets

The config file holds no secret values. Five secrets are set out of band; other services
reference them rather than copying them:

| Variable | Service | Referenced by |
|---|---|---|
| `ADMIN_TOKEN` | `@mx/gateway` | `reconciler.ADMIN_TOKEN` |
| `SESSION_SECRET` | `@mx/gateway` | (only the gateway; signs x402 session tokens) |
| `AUTH_TOKEN` | `facilitator` | `@mx/gateway.FALLBACK_FACILITATOR_AUTH_TOKEN` |
| `FACILITATOR_PRIVATE_KEY` | `facilitator` | (only the facilitator) |
| `KEEPER_PRIVATE_KEY` | `gas-keeper` | (only gas-keeper; the float wallet) |
| `AISSTREAM_API_KEY` | `ingest` | (only ingest; from aisstream.io) |

The staging wallet keys live in the operator's macOS Keychain (`pnpm staging:wallets`):

| Keychain item | Address | Purpose |
|---|---|---|
| `x402-staging-pay-to` | `0x35E13c683A70fBe048CDB897cE1bAe36440fcd19` | payee (receive-only) |
| `x402-staging-facilitator` | `0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5` | facilitator gas wallet |
| `x402-staging-gas-keeper` | printed by `pnpm staging:wallets` | gas-keeper float: test USDC + a little ETH |

Never use `ctx.randomString` in `.railway/railway.ts` for secrets: it is a deterministic hash of the
environment name and a label, so anyone can compute it.

## First-time setup

Run from the repo root on the operator's machine (Railway CLI 5.x, linked with `railway link` to
project `authentic-rebirth`, environment `staging`).

1. **Push the branch** named by `STAGING_BRANCH`, so Railway can build the code this file describes.
2. **Apply the infrastructure.** Review the plan first:
   ```bash
   railway config plan
   railway config apply
   ```
3. **Set the secrets.** Values are generated locally, piped over stdin, and never printed:
   ```bash
   openssl rand -hex 32 | railway variable set ADMIN_TOKEN --stdin -s @mx/gateway --skip-deploys
   openssl rand -hex 32 | railway variable set SESSION_SECRET --stdin -s @mx/gateway --skip-deploys
   openssl rand -hex 32 | railway variable set AUTH_TOKEN --stdin -s facilitator --skip-deploys
   security find-generic-password -s x402-staging-facilitator -a x402 -w \
     | railway variable set FACILITATOR_PRIVATE_KEY --stdin -s facilitator --skip-deploys
   ```
   Then **seal** all four in the Railway dashboard (Variables, then the ⋯ menu, then Seal): a sealed
   value can be used by deploys but never read back. To read the admin token later, rotate it instead.
4. **Give the gateway a public domain:** `railway domain -s @mx/gateway`.
5. **Fund the facilitator gas wallet** `0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5` with a little
   Base Sepolia ETH from a faucet. It needs only gas; it never holds customer funds. Until it is funded
   the facilitator deploys and serves `/healthz`, but its `/readyz` reports `gas: false` and it cannot
   settle, so the gateway uses the x402.org primary.
6. **Redeploy:** `railway redeploy -s facilitator`, then `-s @mx/gateway`, then `-s reconciler`.

## Turning on the gas-keeper (once)

Follow [gas-keeper.md, Setting it up](gas-keeper.md#setting-it-up): `pnpm staging:wallets` (creates
only the missing `x402-staging-gas-keeper` key), fund the printed address with Base Sepolia ETH
(faucet) and test USDC (https://faucet.circle.com), set `KEEPER_PRIVATE_KEY`, seal it, then
`railway config plan` / `apply` (adds `gas-keeper`). Then set its `ALERT_WEBHOOK_URL` (preserved by
the file, like a secret: `railway variable set ALERT_WEBHOOK_URL --stdin -s gas-keeper`), or its alerts
reach only its private `/readyz`. Staging uses smaller caps and a 5% slippage
band, because the Base Sepolia pool is thin.

## Turning on the hot path and sessions (once)

The gateway refuses to start with `SESSIONS_ENABLED=true` and no `SESSION_SECRET`, so set the secret
**before** the deploy that enables sessions (a failed healthcheck keeps the old deployment serving,
but there is no reason to see one):

```bash
openssl rand -hex 32 | railway variable set SESSION_SECRET --stdin -s @mx/gateway --skip-deploys
railway config plan    # gateway: + GRID_SOURCE, + SESSIONS_ENABLED (SESSION_SECRET preserved)
railway config apply
```

Rotating `SESSION_SECRET` invalidates every session token in flight (their prepaid balances expire
as breakage), so rotate only on suspected compromise.

## Turning on live AIS (once)

The gateway starts without the bus and retries it forever; until AIS flows, maritime reports not
ready and its regions are stale, so nothing is charged. Order matters only for a clean first deploy:

1. **Add `nats`** (dashboard: New, Docker Image, `nats:2.10.29-alpine`). No variables, no domain.
   Its private name must be `nats` (Settings, Private Networking).
2. **Add `ingest`** (dashboard: New, GitHub Repo, this repo, branch `STAGING_BRANCH`). Set the
   variables from `.railway/railway.ts`, with `AISSTREAM_API_KEY` pasted in and sealed. Start command
   `pnpm --filter @mx/ingest start`, health check `/healthz`. Private name `ingest`. No domain.
3. **Switch the gateway**: `DATA_SOURCE=nats`, `NATS_URL=nats://nats.railway.internal:4222`.

Coverage is community terrestrial receivers: Dover and Rotterdam fill within minutes; Panama is
sparse and may stay stale. **Licensing:** AISStream is a development/beta source. Clear its terms
before selling derived data on mainnet (`apps/ingest/src/sources/aisstream.ts`).

## Checks

```bash
curl https://<gateway-domain>/readyz       # {"ok":true,"db":true,"products":{"maritime":true,"grid":true},"degraded":[],…}
curl https://<gateway-domain>/v1/products  # maritime and grid
curl https://<gateway-domain>/v1/sessions/sizes   # usd1, usd5, usd20 (sessions on)
curl https://<gateway-domain>/v1/grid/countries   # endpoints include grid.history, grid.revisions, grid.stream
railway logs -s reconciler                 # one JSON line per run: "ok":true
railway logs -s ingest-env                 # "fetched" lines; changed > 0 after each NESO publish
railway logs -s ingest                     # "aisstream subscribed", then no "aisstream error" lines
curl https://<gateway-domain>/status       # maritime feed_connected true; dover/rotterdam "mode":"live", data_age_s < 120
```

Pay end to end with test USDC from https://faucet.circle.com (Base Sepolia):

```bash
GATEWAY_URL=https://<gateway-domain> WALLET_PRIVATE_KEY=<a Base Sepolia test wallet> pnpm demo:agent
```

Client IP header (per-IP rate limits trust exactly `CLIENT_IP_HEADER`). Prove the edge overwrites
it: 21 failed sign-ins, each forging a different value, must end in 429. A 401 at the end means
clients can pick their own bucket: stop and choose another header.

```bash
for i in $(seq 1 21); do curl -s -o /dev/null -w '%{http_code} ' -H "Origin: https://<gateway-domain>" \
  -H "X-Real-IP: 10.9.$i.1" -d "email=probe-$i@example.com&password=wrong+password+here" \
  https://<gateway-domain>/signin; done; echo   # ... 401 429
```

## Operations

- **Reconciliation alert.** The reconciler logs `"level":"error"` with `persistent` problems, which
  were seen in two consecutive runs. A single-run problem is usually a settlement in flight. Set
  `RECONCILE_ALERT_WEBHOOK_URL` (e.g. a Slack incoming webhook) in the file to be paged.
- **Facilitator gas.** `gas-keeper` refills it from the float wallet ([gas-keeper.md](gas-keeper.md));
  set its `ALERT_WEBHOOK_URL` to hear when the float runs low. `facilitator_gas_balance_wei` on the
  facilitator's `/metrics` and `/readyz` still report the balance directly.
- **Rotating a secret.** Set the new value as in step 3, then redeploy the owner and every service
  that references it.
- **Production** is a separate environment and is deliberately not described by this file.
