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
| `apps/facilitator` | Self-hosted x402 facilitator (`/supported`, `/verify`, `/settle`): the gateway's fallback when CDP is down, and the settlement path in e2e |
| `apps/mcp` | MCP server (stdio) for agents, paying through the policy SDK |
| `packages/ais` | NMEA/AIS decoder, dedupe, traffic simulator |
| `packages/policy-sdk` | Buyer-side policy engine (Product B, thin) |
| `packages/shared` | Regions, pricing, geo, types |
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
