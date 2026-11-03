# MVP: Design & Review Notes

| | |
|---|---|
| **Status** | Draft for review. Not deployed. |
| **Date** | 22 October 2026 |
| **Plan** | [implementation.md](implementation.md). This MVP covers the pitch scope of M1–M2 plus a thin M3/M4. |
| **Verification** | 65 automated tests passing. A local end-to-end run was done against real Postgres, NATS and the public Base Sepolia facilitator (§9). |

This document is for reviewers. It explains what was built, the invariants the money path depends on, where the MVP departs from the plan, and the known gaps. Each gap is listed so it gets a decision, not missed.

---

## 1. What the MVP does

An AI agent or business can buy **live maritime data with no account** (x402, USDC on Base) or with **prepaid GBP credits** (Stripe or bank transfer). Both rails are governed by a **buyer-side policy engine**. Every penny lands in a **hash-chained, double-entry GBP ledger** with VAT treatment and the evidence HMRC needs for crypto valuation.

| Capability | In MVP | Where |
|---|---|---|
| AIS ingest: own receivers (UDP/TCP NMEA), aisstream.io, simulator | ✅ | [apps/ingest](apps/ingest/src/index.ts) |
| AIS decoder (types 1/2/3/5/18/24), multipart, dedupe across receivers | ✅ verified against pyais | [packages/ais](packages/ais/src/decode.ts) |
| 250 ms immutable in-memory snapshots, pre-serialised responses | ✅ | [snapshot/engine.ts](apps/gateway/src/snapshot/engine.ts) |
| Derived signals: H3 density, anchorage queue + wait times, anomalies (going dark, jumps, loitering) | ✅ | [snapshot/derive.ts](apps/gateway/src/snapshot/derive.ts) |
| x402 v2 paywall (`@x402/core` 2.28), verify-then-serve with async settlement and an exposure cap | ✅ | [payments/billing.ts](apps/gateway/src/payments/billing.ts) |
| Facilitator circuit breaker + optional self-hosted fallback | ✅ | [payments/facilitator.ts](apps/gateway/src/payments/facilitator.ts) |
| Settlement worker: leased claims (multi-replica safe), retries, on-chain reconciliation | ✅ | [payments/settlement.ts](apps/gateway/src/payments/settlement.ts) |
| Sanctions screening (denylist + Chainalysis free API) | ✅ | [payments/sanctions.ts](apps/gateway/src/payments/sanctions.ts) |
| **Fiat credits:** accounts, API keys, Stripe Checkout, idempotent webhooks, bank top-ups, VAT | ✅ | [credits/](apps/gateway/src/credits/service.ts) |
| Ledger: double-entry, hash-chained, append-only (DB trigger), HMRC CSV, VAT box 1/6 helper | ✅ | [ledger/journal.ts](apps/gateway/src/ledger/journal.ts) |
| Policy SDK (Product B, thin): budgets, allowlists, max price, 4 circuit breakers, spend log, SAP accrual CSV | ✅ | [packages/policy-sdk](packages/policy-sdk/src/client.ts) |
| MCP server (stdio, customer-side) with 7 tools, paying through the policy SDK | ✅ | [apps/mcp](apps/mcp/src/index.ts) |
| Operator console (regions, money, VAT, payments with Basescan links, policy events) | ✅ | `/console` |
| Health, readiness, public status, Prometheus metrics, OpenAPI | ✅ | [routes/public.ts](apps/gateway/src/routes/public.ts) |
| ZK KYC, Oracle connector, live SAP posting, Cedar, SSO, multi-region DR | ❌ roadmap (M4–M7) | |

---

## 2. Architecture

```
 Own receivers ──UDP/TCP NMEA──┐                                  ┌── Agent / Claude ── MCP server (customer side)
 (AIS-catcher, WireGuard)      │                                  │                       │ policy SDK: budgets, breakers
 aisstream.io ──websocket──────┼─► ingest ──NATS ais.pos.<region>─┤                       ▼
 simulator (dev/demo) ─────────┘     │      ais.static            │   GET /v1/{region}/…  ──►  gateway (Hono)
                                     ▼                            │                          │ 250 ms snapshots (in-memory)
                              Postgres: ais_positions             └──────────────────────────┤ billing: credits | x402 | 402
                                                                                             │
                     Stripe Checkout ◄── credits top-up ──────────────────────────────────────┤
                     x402 facilitator (CDP) ◄── verify / settle (breaker + fallback) ─────────┤
                     Base (USDC → Safe multisig) ◄─────────────────────────────────────────────┤
                                                                                             ▼
                                                 Postgres: payments, credits, ledger (hash chain), policy events
```

**Request path for a paid call:** region lookup → staleness/mode gate → precheck → billing → handler. The handler only reads a pointer to an immutable snapshot whose JSON was built off the request path. Unfiltered responses do no work per request.

---

## 3. Payment rails

### 3.1 x402 (account-free)

1. No payment header: respond **402** with an x402 v2 `PAYMENT-REQUIRED` header. The JSON body also carries a `credits` block advertising the fiat alternative.
2. `PAYMENT-SIGNATURE` present:
   1. Decode it and match it against requirements cached per endpoint.
   2. Screen the payer for sanctions.
   3. **Verify with the facilitator** (behind a breaker).
   4. Insert into `x402_payments`. The unique key `(network, payer, nonce)` blocks replay.
3. **Async mode (default):** admitted as async only if global and per-payer exposure (summed over every replica, in Postgres) stays within the caps → serve → a worker settles after 2 s. If the handler returns ≥400, the payment is cancelled and never settled.
4. **Sync fallback:** used when the global or per-payer exposure cap would be exceeded, or the authorisation expires within 30 s. Settle first, serve second, and return `PAYMENT-RESPONSE`.
5. On settlement, write a journal: Dr USDC wallet (GBP at the FX quote captured at verify time) / Cr revenue (net) / Cr VAT output (gross ÷ 6).

### 3.2 Fiat credits (identified B2B)

- `POST /v1/credits/accounts`: company, email, country, VAT number. Non-UK accounts must give a tax ID (B2B only). The API key is shown once and stored as a SHA-256 hash.
- Top-up options:
  - **Stripe Checkout** in GBP. We compute VAT and show it as a separate line. Stripe invoice creation is on. The webhook is signature-checked and idempotent on the session ID.
  - **Bank transfer**, entered by ops through `/admin/credits/:id/topup`. Idempotent on the reference.
- Per call, one DB transaction does three things: a conditional debit (`balance >= price`), a usage row, and a journal entry (Dr credits liability / Cr revenue). Handler responses ≥400 are refunded with a reversing journal.
- VAT on credits is recognised **at top-up** (single-purpose voucher view). **The accountant must confirm this.**

---

## 4. Invariants (what reviewers should try to break)

| # | Invariant | Enforced by | Tested in |
|---|---|---|---|
| I1 | We never charge for stale data | Staleness gate before billing | `never charges for stale data` |
| I2 | Simulated or replay data is never sold on mainnet | Mode gate before billing | `never sells simulated data on mainnet` |
| I3 | An authorisation is used at most once | DB unique key + facilitator + on-chain nonce | `rejects a replayed payment signature` |
| I4 | Verified-but-unsettled value is bounded, globally | `Store.admitPayment`: admission under a Postgres advisory lock, exposure derived from unsettled async rows → otherwise sync | contract `admission and exposure (R4)`; Postgres `R4: exposure caps hold globally`; e2e `exposure caps are global across replicas` |
| I5 | A failed handler never results in a charge | Precheck for 404s; refund (credits) / cancel (async x402) on ≥400 | `does not charge for a vessel…`, credits test |
| I6 | Facilitator outage returns 503 (never charged), not 402 | `FailoverFacilitator` + breaker | `does not charge when the facilitator is down` |
| I7 | Two replicas never settle the same payment concurrently | `claimDuePayments` lease (`FOR UPDATE SKIP LOCKED`) | `I7: two replicas claiming concurrently…` (integration) |
| I8 | Ledger is balanced, append-only and tamper-evident | `assertBalanced`, DB trigger, hash chain | `detects tampering…`; trigger verified on Postgres |
| I9 | Credits balance never goes negative | Conditional `UPDATE … WHERE balance >= $price` + CHECK constraint | credits test |
| I10 | The buyer signs exactly the requirement its policy approved | SDK passes only the approved `accepts` entry to the signer | policy tests |

---

## 5. Departures from implementation.md (for approval)

| Plan | MVP | Why | Revisit |
|---|---|---|---|
| Rust ingest (D2) | TypeScript ingest | One language for a 1–2 person team. Volume for 3 regions is small. | When profiling says so |
| Cedar policies (D4) | JSON policy + fixed rule set | Fast to build. Rules map one-to-one onto Cedar later. | M4 |
| NATS JetStream | NATS core pub/sub | Gateways rebuild state within seconds of reconnecting. History goes to Postgres. | M2 if replay is needed |
| Postgres + PostGIS + Timescale | Plain Postgres; geo in memory (H3, ray casting) | Fewer moving parts. Polygons are coarse rectangles for now. | M2 |
| MCP over Streamable HTTP | MCP over **stdio, customer-side** | Keys and policy stay with the customer (non-custodial). A hosted HTTP MCP is a later option. | M2 |
| `@x402/hono` middleware | Custom billing middleware on `@x402/core` | The stock middleware settles synchronously and has no credits rail. We still use the official core for encoding, verify and settle. | n/a |

---

## 6. Data honesty

- Every response includes `mode` (`live` / `simulated`), `snapshot_ts`, `source_ts` and `degraded`.
- A region reports `mode: simulated` if **any** vessel in it is simulated. This is conservative: during development, live and simulated data are never mixed and then sold as live.
- aisstream.io is wired up for development. **Its terms must be checked before any derived data is sold** (implementation.md §2.2). Own receivers are the intended Dover source ([docs/receiver-setup.md](docs/receiver-setup.md)).
- The Panama draught limit is entered by operators with a required `source` (e.g. an ACP advisory number). It is not scraped.

---

## 7. Security notes

- No signing keys on the server's request path. Receiving goes to `PAY_TO`, which should be a Safe multisig.
- Admin endpoints use a bearer token with constant-time compare. ⚠️ Replace with SSO before anyone other than founders has access.
- API keys: 192-bit random, hashed at rest, and sent by the SDK only to allow-listed origins.
- Logs redact `authorization` and `payment-signature`.
- The signup endpoint is rate-limited per IP in-process. Cloudflare is expected in front.
- `@coinbase/x402` postinstall is disabled (it only prints a ToS notice). Only `esbuild` may run build scripts.

---

## 8. Known gaps and risks (review checklist)

| # | Gap | Impact | Proposed fix |
|---|---|---|---|
| R1 | Async mode serves data before settlement; a payer can empty their wallet between verify and settle | Bounded loss ≤ exposure cap (default $25 global / $1 per payer, across all replicas) | Consider the x402 `upto`/batch schemes in M3 |
| R2 | If sync settlement is indeterminate, the client gets 503 but the payment may settle later | Customer charged without data (rare) | Add a "redeem settled payment" path or an automatic refund policy |
| R3 | The SDK counts spend when it signs, even if the seller rejects the payment | Budgets are conservative (over-count) | Intended. Reconcile with the seller's payment-status endpoint later. |
| R4 | ~~Exposure counters are per-instance~~ **Addressed:** exposure is derived from the payments table and enforced at admission under a short global lock (`db/migrations/003`); a contended lock (>2 s) degrades to sync settlement | n/a | Done. The lock serialises async admissions: revisit above ~1k paid req/s |
| E2E | **Addressed:** `pnpm e2e` runs four gateway replicas, the self-hosted facilitator and a real EIP-3009 token on a local chain, and reconciles ledger against chain | n/a | Done |
| R5 | ~~No automated test against Postgres~~ **Addressed:** `pnpm test:integration` runs the Store contract plus concurrency tests (I3, I7, I8, I9) on Postgres 16 in CI | n/a | Done |
| R6 | Admin auth is a single shared token | Weak for a team | SSO (M4) |
| R7 | Anchorage polygons and region boxes are coarse rectangles | Queue and anomaly accuracy | Charted polygons (UKHO / PoR / ACP) |
| R8 | Ledger journal writes are serialised by an advisory lock | Throughput ceiling of roughly 1–2k writes/s | Batch usage journals hourly; hash per batch |
| R9 | The VAT treatment is our reading, not advice | Tax exposure | **Accountant sign-off before mainnet** (D9) |
| R10 | Runs via `tsx` in production | Slower cold start | Bundle with esbuild/tsup before M2 |
| R11 | The gateway exits at boot if the primary facilitator's `/supported` is unreachable and no fallback is set (`resourceServer.initialize()`). Verified by booting against a closed port | A CDP outage during a deploy crash-loops new pods | Always configure `FALLBACK_FACILITATOR_URL` in production; later, retry `initialize()` with backoff and report not-ready instead of exiting |
| R12 | The self-hosted facilitator assigns transaction nonces in-process | Two replicas sharing one key would race for nonces | One replica per key; to scale out, run more facilitators, each with its own key |

---

## 9. Verification performed

**Automated:** `pnpm test` runs 65 tests across 6 packages.
- The AIS decoder is checked against 9 reference vectors generated with **pyais**.
- The gateway e2e suite runs the **real policy SDK and real x402 v2 client signing** against the real Hono app. It uses a facilitator double that performs **real EIP-712 / EIP-3009 signature verification**.
- It covers both payment rails, replay, tampering, facilitator outage, sanctions, staleness, the mainnet gate, exposure-cap sync settlement, Stripe webhook idempotency, VAT figures, the ledger hash chain, the CSV export and the policy breakers.

**Live local run** (scratch Postgres 14, NATS 2.10, public x402.org Base Sepolia facilitator):

| Check | Result |
|---|---|
| NMEA sent over UDP (the receiver path) | Decoded and served. A garbage line was rejected. |
| Smoke script (`scripts/smoke.ts`) | All checks green |
| x402 with an unfunded wallet | Real facilitator answered `invalid_exact_evm_insufficient_balance`; we returned 402 and charged nothing. The SDK's pay-and-fail breaker then blocked the seller after 3 failures, as designed. |
| Credits on Postgres | Idempotent top-ups and exact balance math |
| Ledger | Hash chain verified after the `jsonb` round trip; `UPDATE` on `ledger_journal` rejected by the trigger |
| MCP | Driven by an MCP client over stdio: tools listed, paid calls on credits, policy events received at the control plane |

**Not yet verified:**
- A **funded** testnet payment through to a real settlement transaction. This needs a wallet with Base Sepolia USDC from the Circle faucet. Run `pnpm demo:agent`.
- Real Stripe test-mode Checkout.
- The Docker image build. The Docker daemon was not running on this machine.

---

## 10. Runbook

**Local (zero dependencies):**
```bash
pnpm install
cp .env.example .env          # set PAY_TO to an address you control
pnpm dev:gateway              # in-memory store + simulator; http://localhost:8080/console
```

**Full stack:**
```bash
docker compose up -d postgres nats
# .env: DATA_SOURCE=nats, DATABASE_URL=postgres://mx:mx@localhost:5432/mx
pnpm dev:gateway & pnpm dev:ingest
```

**Demo (testnet):** fund a fresh key with Base Sepolia USDC, then:
```bash
GATEWAY_URL=http://localhost:8080 WALLET_PRIVATE_KEY=0x… pnpm demo:agent
GATEWAY_URL=http://localhost:8080 WALLET_PRIVATE_KEY=0x… pnpm demo:agent --runaway   # breaker demo
```

**Claude Desktop / Claude Code MCP config:**
```json
{ "mcpServers": { "maritime": { "command": "npx", "args": ["tsx", "/path/to/apps/mcp/src/index.ts"],
  "env": { "MX_GATEWAY_URL": "https://…", "MX_API_KEY": "mk_live_…", "MX_DAILY_BUDGET_GBP": "5" } } } }
```

**Mainnet go-live checklist:**
1. Accountant sign-off (D9).
2. `PAY_TO` = Safe 2-of-3.
3. `FACILITATOR=cdp` with keys in Secrets Manager.
4. `BASE_RPC_URL` set.
5. A live data source with resale rights, so `mode=live` (the gateway refuses otherwise).
6. Sanctions denylist loaded; Chainalysis key set.
7. Exposure caps sized for the replica count.
8. Hourly smoke job pointed at production.
9. Stripe live keys and webhook endpoint.

---

## 11. Questions for the reviewer

1. Is **async settlement with a $1 per-payer / $25 global cap** acceptable for launch, or should we start in `sync` mode and switch once we have data?
2. Credit prices are **£0.025 / £0.05 net**, roughly equal to the USDC prices after VAT at today's FX. Should they float with FX or stay fixed?
3. Should credits accounts also be able to call **through** the policy SDK to third-party x402 sellers? (Recommendation: no. That is custody; see implementation.md §8.2.)
4. Which design partner gets the SAP accrual CSV first, so we can validate the column mapping in [accrual.ts](packages/policy-sdk/src/accrual.ts)?
