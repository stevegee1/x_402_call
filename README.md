# Maritime x402 Gateway

Live maritime data for the Dover Strait, the Port of Rotterdam and the Panama Canal. It is sold per request to AI agents and businesses:

- **x402**: account-free, USDC on Base, 0.033–0.066 USDC per call
- **Fiat credits**: prepaid GBP (Stripe or bank transfer), £0.025–£0.05 per call

The repo also contains a **policy SDK** that enterprises use to govern agent spending (budgets, allowlists, circuit breakers, ERP accrual exports), and an **MCP server** that lets Claude and other agents use the data.

- Plan: [implementation.md](implementation.md)
- MVP review notes: [MVP.md](MVP.md)
- Receiver setup: [docs/receiver-setup.md](docs/receiver-setup.md)

## Quick start

```bash
pnpm install
cp .env.example .env     # set PAY_TO
pnpm dev:gateway         # http://localhost:8080  (simulated data, in-memory store)
pnpm test                # unit + in-process e2e (no dependencies)
pnpm test:integration    # Postgres 16 via Testcontainers (needs Docker; or set TEST_PG_URL)
pnpm test:contracts      # Forge tests for the test contracts (needs Foundry v1.8.5)
pnpm e2e                 # real chain end to end (needs Foundry v1.8.5, and Docker or TEST_PG_URL)
pnpm e2e:stack           # the same stack, interactive, with a funded demo wallet
```

### End-to-end harness (`pnpm e2e`)

Nothing is faked except the chain and the token. A local `anvil` reports Base Sepolia's chain id;
`MockUSDC` (EIP-3009, FiatToken's domain and revert strings) and `Multicall3Lite` are installed at the
canonical Base Sepolia USDC and Multicall3 addresses, so every service runs its unmodified testnet
config. The harness boots the self-hosted facilitator and four gateway replicas on one Postgres
(async, sync, a "flaky" one whose facilitator sits behind a fault proxy, and a "failover" one with a
fallback), then pays them with real EIP-3009 signatures.

Scenarios: async and sync settlement on chain, gasless buyers, replay before and after settlement
across replicas, concurrent payments claimed by competing settlement loops, unfunded, tampered and
wrong-chain signatures, refusal before charge, facilitator outage with and without failover, and the
credits rail. It finishes by **reconciling the ledger against the chain in both directions**
(`e2e/src/reconcile.ts`): every USDC transfer into `payTo` is a settled payment with one journal, and
every settled payment is a transfer for the same payer, nonce and amount. It then checks that a
transfer made outside the gateway is detected. Service logs go to `e2e/.logs/`.

Install Foundry with `foundryup --install v1.8.5` (CI pins the same version). Contracts live in
`contracts/`; run `git submodule update --init` for `forge-std`.

## Layout

| Path | What |
|---|---|
| `apps/gateway` | Hono API: platform kernel (catalog, billing on x402 + credits, settlement, ledger, admin console) and products (`src/products/maritime`) |
| `apps/ingest` | AIS ingest: own receivers (UDP/TCP NMEA), aisstream.io, simulator → NATS + Postgres |
| `apps/ingest-env` | Environmental data ingest: stores every published NESO version in Postgres (`env_observation`), for point-in-time history |
| `apps/facilitator` | Self-hosted x402 facilitator (`/supported`, `/verify`, `/settle`): the gateway's fallback when CDP is down, and the settlement path in e2e |
| `apps/mcp` | MCP server (stdio) for agents, paying through the policy SDK |
| `packages/ais` | NMEA/AIS decoder, dedupe, traffic simulator |
| `packages/policy-sdk` | Buyer-side policy engine (Product B, thin) |
| `packages/shared` | Regions, pricing, geo, types |
| `packages/env` | Environmental datasets: NESO client, cleaning rules, append-only version store with as-of reads |
| `contracts` | Foundry: test-only MockUSDC (EIP-3009), Multicall3Lite and ERC-8004 registry mocks, with Forge tests |
| `e2e` | End-to-end harness and ledger/chain reconciler |
| `db/migrations` | SQL schema |
| `scripts` | Demo agent, production smoke check |

## API

The gateway hosts **products**. Each product's paid resources live under `/v1/{product}/…` and are
billed by the platform kernel on both rails. `GET /v1/products` lists them with prices.

| Endpoint | x402 | Credits |
|---|---|---|
| `GET /v1/products`, `/v1/products/{id}`, `/status`, `/openapi.json` | free | free |
| `GET /v1/maritime/regions` | free | free |
| `GET /v1/maritime/{region}/vessels` (`?category=&min_speed_kn=&bbox=`) | 0.033 USDC | £0.025 |
| `GET /v1/maritime/{region}/vessels/{mmsi}` | 0.033 USDC | £0.025 |
| `GET /v1/maritime/{region}/density` | 0.033 USDC | £0.025 |
| `GET /v1/maritime/{region}/queue` | 0.066 USDC | £0.05 |
| `GET /v1/maritime/{region}/anomalies` | 0.066 USDC | £0.05 |

`{region}` is one of `dover`, `rotterdam`, `panama`. The pre-platform paths (`/v1/regions`,
`/v1/{region}/…`) are still served as deprecated aliases with `Deprecation: true` and a
`Link: <…>; rel="successor-version"` header. Credits endpoints are under `/v1/credits/*`.
Operators use `/console`; product operator routes are under `/admin/{product}/…`.

### Grid carbon product (`/v1/grid`)

Carbon-aware scheduling signals for data-centre workloads, from the NESO **Country** Carbon Intensity
Forecast (England, Scotland, Wales; half-hourly, about 48 h ahead). Enable with `GRID_ENABLED=true`.

| Endpoint | Price (x402 / credits) | Returns |
|---|---|---|
| `GET /v1/grid/{country}/intensity` | $0.01 / £0.008 | gCO2/kWh now, next half-hour, share of the next 24 h that is cleaner |
| `GET /v1/grid/{country}/forecast?hours=1-48` | $0.02 / £0.015 | half-hourly forecast from now |
| `GET /v1/grid/{country}/window?duration_h=0.5-12&within_h=…48` | $0.05 / £0.04 | cleanest contiguous window and the saving versus starting now |

- **Licence.** The data is used under the NESO Open Data Licence, which permits commercial use with
  the attribution "Supported by National Energy SO Open Data". Every response carries it, plus a
  notice that the service is not provided or endorsed by NESO. We deliberately do *not* use the
  carbonintensity.org.uk API (its terms forbid selling access to it), nor NESO's regional dataset
  (it stopped updating on 2026-07-24), so signals are country-level, not regional (e.g. Slough).
- **Freshness (I1).** A country is sellable only if the last fetch succeeded within 45 min, the current
  half-hour has a value, the forecast reaches 12 h ahead, and the horizon has advanced within 3 h. That
  last rule catches a frozen upstream whose old forecast still looks plausible. Otherwise paid calls are
  503 and nothing is charged. An upstream outage never makes the gateway unready.
- Bad parameters, unknown countries and jobs that fit no window are refused before any charge.
- `pnpm grid:probe` runs the adapter, freshness rules and signals read-only against live NESO data.

### Environmental data history (`apps/ingest-env`)

NESO overwrites each forecast row in place, so it keeps no old versions. `ingest-env` keeps them
for point-in-time backtests (architecture.md §6). It checks NESO's `last_modified` every 30 s and
reads the records when that moves (and at least every 10 min). It cleans them, then appends only the
values that changed to `env_observation`, stamped with `ingested_at` (the as-of key) and NESO's
`published_at`.

- **Cleaning.** Periods are UTC and must start on a half-hour. Values outside 0 to 2,000 gCO2/kWh
  are stored as `rejected`, with the raw value kept. Absent values are stored as `missing`. Nothing
  is interpolated, and rows that can't be placed are counted, not stored.
- **Append-only.** Triggers block `UPDATE`, `DELETE` and `TRUNCATE`, so an as-of answer never changes.
  Every fetch, failed ones included, is logged in `env_fetch`.
- **Replicas.** Writes take a per-dataset transaction lock, so several replicas never append a change twice.
- **TimescaleDB.** The migration makes `env_observation` a hypertable when the extension is available,
  and leaves a plain table otherwise. `/status` reports which.
- **Serving it.** With `GRID_SOURCE=store` (needs `DATABASE_URL`), the gateway follows the store in
  memory instead of polling NESO: Postgres `LISTEN/NOTIFY` on commit, with a 15 s fallback poll. It
  keeps every version of the last `GRID_HISTORY_MEMORY_DAYS` (default 7) days in memory and adds:

  | Endpoint | x402 | Credits | Returns |
  |---|---|---|---|
  | `GET /v1/grid/{country}/history?from=&to=&as_of=` | $0.05 | £0.04 | Each half-hour in `[from, to)` (up to 7 days) as known at `as_of` (default now), with `known_at` and `published_at` |
  | `GET /v1/grid/{country}/revisions?period=` | $0.02 | £0.015 | Every version of one half-hour, oldest first |

  Times are ISO 8601 with a zone. Older history comes from Postgres, with the same answers. Grid goes
  stale (503, never charged) if the store stops refreshing for 2 min or ingest hasn't fetched for 20 min.
- **Latency budgets.** `pnpm test:latency` runs the hot path through the whole gateway in-process and
  fails above 5 ms p99. It runs alone in CI so other tests don't compete for the CPU.
- **Run it.** The gateway owns migrations, so run `pnpm db:migrate` first, then `pnpm dev:ingest-env`
  (`DATABASE_URL` required). Health is on `:8091`: `/healthz`, `/readyz`, `/status` and `/metrics`.
  A NESO outage never fails `/healthz`.

### x402 sessions: prepay once, read at memory speed

With `SESSIONS_ENABLED=true` (and `SESSION_SECRET`, at least 32 chars and the same on every replica),
a buyer pays once with x402 and then reads any product with `Authorization: Session <token>`:

| Endpoint | x402 | Returns |
|---|---|---|
| `GET /v1/sessions/sizes` | free | Session sizes and how to use them |
| `GET /v1/sessions/usd1` · `usd5` · `usd20` | $1 · $5 · $20 | `201 {session_token, session_id, expires_at, …}`, issued only after the payment settles on chain |
| `GET /v1/grid/{country}/stream` | $0.01 per event, session only | SSE: the forecast on connect, then each new version (`GRID_SOURCE=store`) |

- **Reads:** each one spends the product's x402 price from the session. A read is an HMAC check and an
  in-memory debit, with no facilitator, chain or database. Responses carry
  `X-Session-Charged-Usdc-Atomic` and `X-Session-Remaining-Usdc-Atomic`. A failed handler is refunded.
  An empty session gets a 402 `session_exhausted`, and an expired one a 401 `session_expired`.
- **Rails:** only x402 can buy a session. GBP credits and sessions get a 400 `rail_not_accepted`, uncharged.
- **Replicas:** each lease is `SESSION_LEASE_USD` (default $0.25). Spend is reported every `SESSION_FLUSH_MS`
  (default 1 s). Sessions last `SESSION_TTL_MINUTES` (default 60) from settlement. Unused balance becomes
  breakage `SESSION_CLOSE_GRACE_MS` after expiry. Accounting is in architecture.md §6.4.

### ERC-8004 identity (buyer tiers)

With `ERC8004_ENABLED=true`, a buyer can declare its ERC-8004 agent with `X-Agent-Id: 42` (or the
global form `eip155:84532:<identityRegistry>:42`; the policy SDK sends it via `agentId`). The gateway
checks that the agent's verified wallet (`getAgentWallet`) is the address that signed the payment,
then reads its reputation from the reviewers in `ERC8004_TRUSTED_REVIEWERS`:

| Tier | When | Per-payer exposure cap |
|---|---|---|
| unknown | no id, someone else's id, transferred agent, registry error or timeout | `EXPOSURE_CAP_PER_PAYER_USD` (as without ERC-8004) |
| identified | verified wallet matches the payer | `EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD` |
| trusted | identified, and at least `ERC8004_TRUSTED_MIN_FEEDBACK` reviews averaging `ERC8004_TRUSTED_MIN_SCORE` | `EXPOSURE_CAP_PER_PAYER_TRUSTED_USD` |

Tiers only loosen (config enforces unknown <= identified <= trusted <= `EXPOSURE_CAP_USD`), and the
global cap is never raised. Blocking stays wallet-level (sanctions screening): an identity-based block
would be advisory, since a buyer can omit the header. Responses carry `X-Agent-Tier`. Set
`SELLER_AGENT_ID` to advertise our own agent in 402 responses and on `/`. The canonical registries are
built in (`src/identity/registries.ts`); `pnpm erc8004:probe` checks them read-only against the live chain.

### Adding a product

Implement `Product` ([platform/product.ts](apps/gateway/src/platform/product.ts)) under
`apps/gateway/src/products/<id>/`, declare its priced resources, and add it to the `Catalog` in
[server.ts](apps/gateway/src/server.ts). The catalog validates it at boot. Billing, settlement,
the ledger (`revenue:<id>`), OpenAPI, `/status` and `/readyz` come from the kernel. Products may
not import kernel internals (enforced by `test/platform/boundaries.test.ts`).
