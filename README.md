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
```

## Layout

| Path | What |
|---|---|
| `apps/gateway` | Hono API: platform kernel (catalog, billing on x402 + credits, settlement, ledger, admin console) and products (`src/products/maritime`) |
| `apps/ingest` | AIS ingest: own receivers (UDP/TCP NMEA), aisstream.io, simulator → NATS + Postgres |
| `apps/mcp` | MCP server (stdio) for agents, paying through the policy SDK |
| `packages/ais` | NMEA/AIS decoder, dedupe, traffic simulator |
| `packages/policy-sdk` | Buyer-side policy engine (Product B, thin) |
| `packages/shared` | Regions, pricing, geo, types |
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

### Adding a product

Implement `Product` ([platform/product.ts](apps/gateway/src/platform/product.ts)) under
`apps/gateway/src/products/<id>/`, declare its priced resources, and add it to the `Catalog` in
[server.ts](apps/gateway/src/server.ts). The catalog validates it at boot. Billing, settlement,
the ledger (`revenue:<id>`), OpenAPI, `/status` and `/readyz` come from the kernel. Products may
not import kernel internals (enforced by `test/platform/boundaries.test.ts`).
