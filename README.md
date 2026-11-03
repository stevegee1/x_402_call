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
| `apps/gateway` | Hono API: snapshots, billing (x402 + credits), settlement, ledger, admin console |
| `apps/ingest` | AIS ingest: own receivers (UDP/TCP NMEA), aisstream.io, simulator → NATS + Postgres |
| `apps/mcp` | MCP server (stdio) for agents, paying through the policy SDK |
| `packages/ais` | NMEA/AIS decoder, dedupe, traffic simulator |
| `packages/policy-sdk` | Buyer-side policy engine (Product B, thin) |
| `packages/shared` | Regions, pricing, geo, types |
| `db/migrations` | SQL schema |
| `scripts` | Demo agent, production smoke check |

## API

| Endpoint | x402 | Credits |
|---|---|---|
| `GET /v1/regions`, `/status`, `/openapi.json` | free | free |
| `GET /v1/{region}/vessels` (`?category=&min_speed_kn=&bbox=`) | 0.033 USDC | £0.025 |
| `GET /v1/{region}/vessels/{mmsi}` | 0.033 USDC | £0.025 |
| `GET /v1/{region}/density` | 0.033 USDC | £0.025 |
| `GET /v1/{region}/queue` | 0.066 USDC | £0.05 |
| `GET /v1/{region}/anomalies` | 0.066 USDC | £0.05 |

`{region}` is one of `dover`, `rotterdam`, `panama`. Credits endpoints are under `/v1/credits/*`. Operators use `/console`.
