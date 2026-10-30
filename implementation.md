# Implementation Plan: Maritime x402 Gateway + Policy Engine

| | |
|---|---|
| **Status** | DRAFT for discussion. Not approved. |
| **Date** | 19 October 2026 |
| **Company** | UK-incorporated (England & Wales) |
| **Scope** | (A) Account-free x402 maritime data gateway on Base · (B) Policy-engine middleware for enterprise x402 spend |
| **Approval needed on** | §3 Stack decisions, §6 Milestones, §11 Open questions |

---

## 1. What we are building (and what we are not)

We build **a layer on top of x402**. We do not fork, replace or compete with the protocol, its facilitators or Base. We use the published x402 spec and SDKs as they ship, and we add value in two places:

| Product | What it is | Who pays | Revenue |
|---|---|---|---|
| **A. Maritime Data Gateway** | An account-free HTTP + MCP API. It serves live telemetry and derived signals for the **Dover Strait, Port of Rotterdam and the Panama Canal**, paid per request in USDC on Base via x402. | AI agents, quant/trading desks, logistics SaaS, and enterprise agents that run through product B | 0.033–0.066 USDC per request |
| **B. Policy Engine** | Middleware that sits between an enterprise's agents and systems (SAP/Oracle) and **any** x402 seller, including ours. It adds spend policy, circuit breakers, ERP translation, counterparty compliance (ZK attestations) and HMRC-ready VAT ledgers. | Shipping companies, logistics companies, large shippers (the Amazon tier) | SaaS subscription + per-transaction fee (to be decided, see §11) |

**Two payment rails for Product A (decision D11):**

| Rail | Who | How | Price |
|---|---|---|---|
| **x402** | Agents and developers, no account | `PAYMENT-SIGNATURE` header, USDC on Base | 0.033 / 0.066 USDC, VAT-inclusive |
| **Fiat credits** | Identified business customers that will not touch crypto | Prepay GBP (Stripe Checkout or bank transfer), then `Authorization: Bearer mk_...` per call | £0.025 / £0.05 net + VAT at top-up |

Credits can only be spent on **our own data**, so they are ordinary SaaS prepayment and not custody of customer cryptoassets (§8.2). Credits do **not** pay third-party x402 sellers on a customer's behalf. Doing that would bring us inside the custody perimeter.

**Why both:** A proves we can run x402 in production and gives B a reference seller. B is the defensible business. Enterprises such as Amazon will not hand raw wallets to agents without controls, audit and ERP reconciliation. That gap is what B fills.

**Out of scope for v1:** our own facilitator as a product, our own chain or token, custody of customer funds (see §8.2, which is a deliberate regulatory choice), and vessel-level AIS coverage outside the three regions.

---

## 2. Reality checks before we commit

These constraints shape the plan. Each one is addressed later in the document.

1. **AIS refresh cadence.** Vessels broadcast every 2–10 s when underway and every 3 min at anchor. A **250 ms in-memory refresh** caps how stale *our snapshot* can get on top of the upstream data. It does not make the vessel data itself 250 ms fresh. We should market it as "≤250 ms added latency" and expose `source_ts` and `snapshot_ts` on every response.
2. **Data licensing is the biggest commercial risk.** Most commercial AIS licences (Kpler/Spire, MarineTraffic, ORBCOMM, exactEarth) **forbid redistribution** unless you have a reseller or "value-added" licence. Scraping does not fix this. UK database right, website terms and the Computer Misuse Act all apply. Plan: licensed feeds, plus our own terrestrial receivers, plus official open data. Scraping is used only for public, non-proprietary notices (e.g. canal advisories), after legal review.
3. **Payment latency vs. the 250 ms promise.** In x402 the server checks the payment with a facilitator (`/verify`) and settles on-chain (`/settle`). Settlement waits for a Base block. We will **verify synchronously and settle asynchronously**, with a bounded exposure cap (§4.4). This keeps paid p50 latency under about 150 ms.
4. **"Account-free" vs. VAT.** HMRC needs place-of-supply evidence for digital services. Anonymous B2C-style buyers make that evidence hard to collect. §8.3 sets out a two-tier approach. **We need sign-off from an accountant before mainnet.**
5. **"Account-free" vs. KYC/AML.** Selling data for crypto is not, by itself, a regulated cryptoasset activity in the UK. **Holding or moving customer funds would be.** Product B is designed to be **non-custodial** to stay outside that perimeter (§8.2).
6. **Enterprise buyers buy differently.** Amazon-tier procurement expects SOC 2 Type II or ISO 27001, a DPA, an SLA, invoices in GBP/USD and a named legal entity. "Account-free" is right for agents. Enterprises need an *optional* contract and billing layer on top (M7).

---

## 3. Stack (for discussion)

Each row shows a recommendation, the main alternative, and why we chose one over the other. Items marked ⚠️ need a decision.

### 3.1 Core

| Concern | Recommendation | Alternative | Rationale |
|---|---|---|---|
| Language (gateway, policy engine, MCP) | **TypeScript on Node 22 LTS** | Go | x402 reference SDKs and the MCP SDK are TypeScript-first. One language across A and B. Go remains an option for the hot path if profiling shows a need. |
| HTTP framework | **Hono** | Fastify | Has first-party x402 middleware patterns, is light and fast, and runs at the edge if we need it. |
| AIS ingestion / decoding | **Rust service** (NMEA/AIVDM decode, dedupe, region filter) | TypeScript (`ais-stream-decoder`-style libraries) | High message rates, strict parsing and memory safety. The service is small, isolated and rarely changes. ⚠️ Fall back to TypeScript if the team has no Rust experience. |
| Message bus | **NATS JetStream** | Redis Streams, Kafka/MSK | Low latency, simple to run, replayable, with subject-per-region fan-out. Kafka is too heavy for this volume. |
| Hot state (250 ms) | **In-process immutable snapshot per region**, rebuilt from the bus every 250 ms and swapped atomically, with the **JSON already serialised** and an ETag | Redis read on each request | No network hop on the request path. Every gateway replica builds its own copy. |
| Durable store | **PostgreSQL 16 + PostGIS + TimescaleDB** (AWS RDS, or Timescale Cloud) | ClickHouse for history | Geofences (PostGIS), time-series history (Timescale), and the ledger in one ACID store. ClickHouse can come later for analytics. |
| Ledger | **Append-only, double-entry tables in Postgres, hash-chained** | A dedicated ledger DB (TigerBeetle) | Auditable and easy to export for HMRC. Volume is modest. |
| Policy language | **Cedar** (AWS, open source) | OPA/Rego | Analysable, fast and readable by enterprise compliance teams. ⚠️ OPA has a bigger ecosystem, so we should decide together. |
| MCP | **MCP TypeScript SDK, Streamable HTTP transport**, with x402 payment on tool calls | stdio-only | Agents can discover the server remotely, and paid tools carry x402 headers. |

### 3.2 Payments / chain

| Concern | Recommendation | Notes |
|---|---|---|
| Protocol | **x402, current spec version (v2 at time of writing)**, `exact` scheme, USDC (EIP-3009 `transferWithAuthorization`) | Pin the SDK version, add a conformance test suite, and track the spec repo. Re-confirm v2 header names at kickoff. |
| Network | **Base mainnet** (`eip155:8453`); **Base Sepolia** for staging | USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, re-verified at deploy |
| Facilitator | **Coinbase CDP facilitator as primary**, with a **self-hosted facilitator as circuit-breaker fallback** | Fallback uses the open-source reference facilitator and a gas wallet held in KMS. Confirm current CDP fee tiers. |
| Price points | 0.033 USDC (snapshots/lists) and 0.066 USDC (derived analytics, ETA, congestion) | That is 33 000 / 66 000 atomic units (6 decimals). Prices live in config and are never hard-coded. |
| Receiving wallet | **Safe multisig (2-of-3) on Base**, used for receiving only | No hot private key on the request path. |
| Treasury | Sweep to a **UK-regulated off-ramp** (e.g. Coinbase Prime/Institutional, or another FCA-registered provider), then GBP to the business bank | ⚠️ Choose the provider. Ledger records the GBP rate at receipt and at disposal. |
| Discovery | List in the **x402 Bazaar** discovery layer and publish the MCP manifest | Free distribution to agent builders. |

### 3.3 Platform

| Concern | Recommendation |
|---|---|
| Cloud / region | **AWS eu-west-2 (London)** primary, **eu-west-1 (Dublin)** for DR. UK data residency suits UK enterprise and public-sector buyers. |
| Compute | **ECS Fargate** to start. Move to EKS only if the sidecar/proxy product needs it. |
| Edge | **Cloudflare** (WAF, DDoS, rate limits on unpaid 402 challenges). **No caching of paid responses.** |
| IaC / CI | Terraform; GitHub Actions; environments dev → staging (Base Sepolia) → prod (Base) |
| Secrets / keys | AWS KMS + Secrets Manager. Facilitator-fallback gas key in KMS (secp256k1). |
| Observability | OpenTelemetry → Grafana Cloud (metrics, logs, traces) + Sentry. On-chain monitoring with our own indexer, or Alchemy/QuickNode webhooks. |
| Wallet infra (B, hosted option) | **CDP Server Wallets or Turnkey**, with the **customer as policy owner** (non-custodial, see §8.2) |
| Sanctions screening | Chainalysis or TRM or Elliptic for wallet addresses, plus OFSI/OFAC/UN lists for entities. ⚠️ Choose a vendor. |

### 3.4 Repository layout (monorepo, pnpm + Turborepo)

```
/apps
  gateway/            # Hono x402 data API (Product A)
  mcp-server/         # MCP Streamable HTTP server (Product A)
  ingest-ais/         # Rust: AIS decode → NATS
  ingest-official/    # TS: port/canal/MCA/CNIS official feeds + scrapers
  snapshot-builder/   # optional: if snapshot build moves out of gateway
  policy-proxy/       # Product B: forward proxy / sidecar
  control-plane/      # Product B: policy admin API + UI (Next.js)
  ledger-worker/      # settlement reconciliation, VAT, HMRC exports
  erp-sap/            # SAP connector
  erp-oracle/         # Oracle connector
/packages
  x402-kit/           # thin wrappers over official x402 SDKs (pinned)
  policy-sdk/         # Product B client SDK (wraps x402 fetch/axios)
  schemas/            # zod/JSON Schema/OpenAPI for all payloads
  geo/                # region polygons, H3 indexing
  ledger-core/        # double-entry primitives
/infra                # Terraform
/docs                 # ADRs, runbooks, threat model
```

---

## 4. Product A: Maritime Data Gateway

### 4.1 Data sources (by priority)

| Region | Sources (licensed / official first) | Derived products |
|---|---|---|
| **Dover Strait** (TSS, CNIS area) | Our own terrestrial AIS receivers (Kent coast, 2–3 sites); licensed AIS feed with redistribution rights; MCA/CNIS public notices; UKHO navigational warnings | Live vessel positions in the TSS, lane density, crossing-ferry conflicts, speed anomalies, AIS-gap ("dark") flags |
| **Rotterdam** | Licensed AIS; Port of Rotterdam public/partner APIs (e.g. PortXchange/Pronto-style port-call data, where licensable); Rijkswaterstaat open data (water levels, weather) | Anchorage queue length, berth congestion index, port-call ETA vs. actual |
| **Panama Canal** | Licensed AIS (satellite needed offshore); **ACP published advisories, draft restrictions and transit/booking data**; Gatun Lake level | Transit queue by direction and lock set, waiting-time estimate, draft-restriction impact |

**Licence gate:** a source is not used in production until its licence explicitly permits paid redistribution of raw or derived data. The legal workstream in M0 owns this.

### 4.2 Pipeline

```
Receivers / feeds / scrapers
        │
   ingest-ais (Rust)  ingest-official (TS)
        │  decode, validate, dedupe, geo-filter (H3 + PostGIS polygons)
        ▼
   NATS JetStream  subjects: ais.<region>, port.<region>, canal.panama
        │                                   │
        ▼                                   ▼
   gateway replicas (N)                Timescale writer (history)
   • consume stream
   • every 250 ms: build immutable snapshot → pre-serialise → swap pointer
   • serve paid requests from memory
```

- **Data quality:** reject impossible positions and speeds. Flag MMSI collisions and spoofing patterns. Mark GNSS-jamming zones. Every record carries `quality_flags`.
- **Freshness contract:** every response includes `source_ts`, `snapshot_ts` and `snapshot_seq`. If a source is stale beyond its threshold, we return a 200 with `degraded: true`. We **never charge for an empty or stale snapshot** (the circuit breaker in §4.4 refuses payment).

### 4.3 API surface (v1)

| Endpoint | Price (USDC) | Description |
|---|---|---|
| `GET /v1/regions` | free | Region catalogue, prices, freshness status |
| `GET /v1/{region}/vessels` | 0.033 | Current vessel snapshot (filterable by type, bbox, speed) |
| `GET /v1/{region}/vessels/{mmsi}` | 0.033 | Single vessel latest state + last-N track points |
| `GET /v1/{region}/density` | 0.033 | H3-binned traffic density |
| `GET /v1/rotterdam/congestion` | 0.066 | Anchorage queue + berth congestion index |
| `GET /v1/panama/transit-queue` | 0.066 | Queue by direction and lock, est. wait, draft limits |
| `GET /v1/{region}/eta/{mmsi}` | 0.066 | Model-based ETA with confidence |
| `GET /v1/{region}/anomalies` | 0.066 | AIS gaps, loitering, speed/course anomalies |
| `GET /.well-known/mcp.json` / MCP endpoint | free discovery; tools priced as above | MCP manifest; each tool maps to a paid endpoint |
| `GET /openapi.json` | free | OpenAPI 3.1 including x402 price metadata |

Unpaid requests get **HTTP 402** with x402 payment requirements: price, `payTo` Safe address, asset, network and resource. Paid requests get **200**, plus a payment-response header that carries the settlement reference once it is available.

### 4.4 Payment flow and circuit breakers (gateway side)

1. Request arrives with a payment header. Validate the schema, check the price, check the nonce has not been seen before (local LRU plus Redis set, TTL equal to the authorisation validity window).
2. Call **facilitator `/verify`** with a 300 ms timeout.
3. **Serve from the in-memory snapshot** (target <5 ms).
4. **Queue `/settle`** in a settlement worker, which batches concurrency and retries idempotently.
5. Write ledger entries: `receivable` on verify, moved to `cash` on confirmed settlement, or written off on failure.

**Breakers (each with metrics, alerts and a manual override):**

| Breaker | Trips when | Action |
|---|---|---|
| Facilitator health | Error rate >5% or p95 >1 s over 30 s | Fail over to the self-hosted facilitator. If that also fails, return 503 (not 402). |
| Unsettled exposure | Verified-but-unsettled value >X USDC (global) or >Y per payer address | Switch to **settle-before-serve** for the affected payer or all payers |
| Data staleness | Region snapshot older than its threshold | Stop charging for that region: return 503 with `Retry-After`, no 402 |
| Settlement failure rate | >1% of settles fail in 5 min | Page on-call and tighten the exposure cap |
| Sanctions hit | Payer address appears on a screening list | Refuse (403), never serve, log for reporting obligations |

### 4.5 Performance SLOs (Product A)

| Metric | Target |
|---|---|
| Snapshot rebuild interval | 250 ms (p99 ≤ 300 ms) |
| Paid request p50 / p99 (excl. client network) | ≤ 150 ms / ≤ 450 ms (dominated by `/verify`) |
| Free/402 challenge p99 | ≤ 20 ms |
| Availability (monthly) | 99.9% |
| Settlement success | ≥ 99.5% within 60 s |

---

## 5. Product B: Policy Engine

### 5.1 Positioning

B is protocol-neutral middleware. It governs **any** x402 payment an enterprise's agents make, not just payments to us. There are three ways to deploy it:

| Mode | How | For |
|---|---|---|
| **SDK** | `@ourco/policy-sdk` wraps the official x402 fetch/axios clients. Policy is checked before each payment is signed. | Teams building their own agents |
| **Proxy / sidecar** | Forward HTTP proxy. Agents call x402 sellers through it, and the proxy handles the 402 handshake under policy. | Enterprises that want central control without code changes |
| **Hosted control plane** | Policy authoring, approvals, audit, ledgers and ERP sync (SaaS, UK-hosted) | Finance, procurement and compliance teams |

### 5.2 Capabilities

1. **Spend policies (Cedar):** per-agent, per-team and per-cost-centre budgets; seller allowlists and denylists; maximum price per request; time windows; human approval above a threshold.
2. **Circuit breakers (buyer side):** spend velocity (e.g. >£N/min), price anomalies (seller raised its price), repeated 5xx after payment (pay-and-fail), seller staleness, and loop detection (an agent paying for the same resource repeatedly).
3. **ERP protocol translation:**
   - **SAP S/4HANA:** OData v4 APIs for purchase orders, supplier invoices and journal entries. SAP BTP Event Mesh for events. IDoc only for legacy ECC.
   - **Oracle Fusion Cloud SCM/Financials:** REST APIs for requisitions, payables invoices and GL journals.
   - Mapping: an x402 "seller + resource" maps to an ERP supplier + material/service. Micro-payments are **aggregated into daily or periodic accrual journals**, never one ERP document per request.
   - The ERP can drive policy too: an approved PO in SAP sets the budget envelope in the policy engine.
4. **Zero-knowledge compliance (counterparty):** before paying a seller, require a verifiable attestation (e.g. "UK/EU-registered legal entity, not sanctioned") **without exposing the underlying identity documents**. Phase 1: on-chain attestations (EAS on Base, e.g. Coinbase Verifications) plus sanctions screening. Phase 2: ZK proofs (candidates: Privado ID/Polygon ID, zkPassport, Self). Proofs are checked in the policy engine before signing. ⚠️ ZK KYC tooling is still maturing. We will pilot it with a design partner before committing.
5. **HMRC-ready VAT ledger:** each payment is recorded with tx hash, seller, supplier VAT status, place-of-supply evidence, GBP value at the time (FX source plus timestamp) and VAT treatment (standard, reverse charge, outside scope). Exports: MTD-compatible VAT return figures (submitted through the customer's existing MTD software or bridging tool), CSV/JSON audit packs, and a SAF-T-style ledger.
6. **Scraping maintenance (managed connectors):** for sellers or sources with no API, we maintain monitored connectors. These include Playwright jobs, schema-drift detection, golden-response tests, canary runs every 5 min and alerting. They are covered by the same licence gate as §4.1.

### 5.3 Wallet model

- **Default: customer-owned wallets.** The customer holds the keys (own HSM/KMS) or uses CDP Server Wallets/Turnkey with **the customer as root policy owner**. Our engine **approves or denies signing**. It never holds keys that move customer funds on its own authority.
- This keeps us **non-custodial** (§8.2). It is an architectural constraint, enforced in code review and the threat model.

---

## 6. Milestones

Assumes a core team of **5–6 engineers** (2 backend TS, 1 Rust/data, 1 infra/SRE, 1 full-stack, 0.5 security) plus a fractional compliance lead and outside legal/accounting advisers. Durations are elapsed weeks. Milestones overlap where noted.

| # | Milestone | Weeks | Depends on | Exit criteria (must all be true) |
|---|---|---|---|---|
| **M0** | **Discovery, legal & licensing** | 0–4 | n/a | • Data-licence term sheets for ≥1 AIS feed with redistribution rights • Legal memo: non-custodial perimeter, crypto acceptance, scraping/database right • Accountant memo: VAT treatment of anonymous vs. identified buyers • ADRs signed off for §3 decisions • 2 design-partner LOIs for Product B (target: 1 shipping line, 1 freight forwarder/3PL) |
| **M1** | **Gateway MVP (testnet, Dover Strait)** | 3–9 | M0 ADRs | • AIS ingest → NATS → 250 ms snapshot running in staging • 3 Dover endpoints behind x402 on **Base Sepolia** with the CDP facilitator • Verify-then-serve with async settle; ledger writes • Freshness fields and staleness breaker • Load test: 500 RPS paid, SLOs in §4.5 met • Conformance tests against the x402 spec |
| **M2** | **Mainnet + all regions + MCP** | 9–15 | M1, licence signed | • Base mainnet, Safe receiving wallet, treasury sweep runbook • Rotterdam + Panama endpoints, derived products (congestion, transit queue) • MCP server (Streamable HTTP) + manifest + x402 Bazaar listing • Facilitator failover tested in a game day • Sanctions screening live • External pen test (gateway scope) passed, criticals/highs fixed |
| **M3** | **Ledger, treasury & VAT (Product A)** | 12–17 | M2 | • Double-entry ledger reconciled to chain daily (zero unexplained variance) • GBP valuation per transaction • VAT treatment per §8.3 implemented • Monthly close pack reviewed by accountant |
| **M4** | **Policy Engine core (SDK + proxy)** | 14–22 | M0 LOIs | • Cedar policies: budgets, allowlists, max price, approvals • Buyer-side circuit breakers (§5.2.2) • SDK + forward proxy, both against our gateway and ≥2 third-party x402 sellers • Control plane: policies, audit log, SSO (SAML/OIDC) • Design partner #1 in sandbox |
| **M5** | **ERP connector #1 (SAP S/4HANA)** | 20–28 | M4 | • PO-driven budgets • Aggregated accrual journals posted to the partner's SAP sandbox • Reconciliation report: x402 payments ↔ SAP journals, 100% matched • Oracle Fusion connector in design (built in M5b if a partner needs it) |
| **M6** | **Compliance layer** | 24–32 | M4 | • EAS attestation checks + sanctions in policy (phase 1) • ZK proof verification pilot with one provider (phase 2, gated by pilot results) • HMRC-ready VAT ledger for Product B customers + MTD-compatible export |
| **M7** | **Enterprise readiness** | 20–36 (parallel) | M2 | • ISO 27001 certification **or** SOC 2 Type II observation period underway (Type I report in hand) • DPA, SLA, MSA templates • Optional invoiced billing (prepaid USDC credits or GBP invoices that settle into x402 under the hood) • DR tested (RPO ≤ 5 min, RTO ≤ 1 h) • 24/7 on-call |
| **GA** | **General availability** | ~36 | M2–M7 | 2 paying Product B customers in production; Product A revenue covering data licence costs |

**Proposed approval gates:** end of M0 (go/no-go on licences and legal), end of M2 (mainnet spend), end of M4 (commit to ERP build).

---

## 7. Security

- **Threat model** (STRIDE) per service, kept in `/docs/threat-model`, reviewed at each milestone.
- **Payment-specific threats:** replayed authorisations (contract nonce plus our nonce cache), verify-then-default exposure (breaker §4.4), price-substitution attacks (server is the source of truth for price and resource binding), facilitator compromise (fallback, and monitoring that settlement amounts match quotes), malicious sellers draining agents (Product B breakers).
- **Data-integrity threats:** AIS spoofing, GNSS jamming and poisoned scraped pages. Handled by quality flags, cross-source validation and anomaly detection.
- **Key management:** no request-path signing keys in Product A. Fallback gas key and Product B approval keys in KMS/HSM, rotated, with dual control.
- **AppSec:** SAST (Semgrep), dependency/SBOM scanning (with x402 and viem pinned and reviewed), container scanning, signed builds (Sigstore), branch protection, two-person review on payment and ledger code.
- **Pen tests:** before M2 (gateway) and before GA (Product B + control plane).

---

## 8. UK legal, regulatory & tax workstream

> Plan-level summary only. This is **not legal or tax advice**. Each item needs a written opinion from qualified UK advisers in M0.

### 8.1 Corporate & data protection
- Register with the ICO (data protection fee). AIS data is mostly vessel-level, but enterprise customer data and any crew-linked data fall under UK GDPR.
- DPA and ROPA. International transfer assessments (UK IDTA) for any non-UK processors.

### 8.2 Cryptoasset perimeter
- **Product A:** accepting USDC as payment for our own data service is generally not a regulated cryptoasset activity under the MLRs 2017. **Needs confirmation.**
- **Product B:** must stay **non-custodial**. If we held or transferred customer cryptoassets on their behalf, we would likely need **FCA registration as a cryptoasset business (MLRs)** and, once in force, authorisation under the UK's new cryptoasset regime under FSMA. Commencement is currently expected in 2027. Confirm the date and track HM Treasury/FCA publications.
- Stablecoin regime: monitor FCA rules on UK-issued stablecoins and on the use of overseas stablecoins (USDC) in payments.

### 8.3 VAT (needs accountant sign-off)
- **Fiat credits (identified B2B accounts):** UK customers are charged 20% VAT **at top-up**, treating credits as a single-purpose voucher because they are redeemable only for our UK-supplied data. Non-UK customers must give a VAT/tax ID and are invoiced under the reverse charge. We do not open non-UK consumer accounts. The accountant must confirm the voucher treatment.
- **Identified business customers (Product B, enterprise tier):** standard B2B rules. UK customer = 20% VAT. Overseas business customer = generally outside the scope of UK VAT (customer reverse-charges). We need evidence of business status and location.
- **Anonymous x402 buyers (Product A):** without customer-location evidence, the safe default is **to treat sales as UK-supplied and VAT-inclusive**: 0.033 USDC gross includes VAT, or we price net + 20%. ⚠️ Decide. Optional: let buyers send a signed business-status/VAT-number attestation in a header to get B2B treatment.
- Cryptoasset receipts valued in GBP at the time of supply (HMRC Cryptoassets Manual). FX source and timestamp are stored per transaction.
- MTD for VAT: submit through compatible software. Our ledger exports feed it.

### 8.4 Sanctions
- Screen payer and seller addresses (OFSI, OFAC, UN, EU lists). Maritime data is sanctions-sensitive (shadow-fleet tracking). Document our own reporting and escalation process.

### 8.5 Data licensing & scraping
- Licence register: source, permitted use, redistribution rights, attribution, termination terms.
- Scraping policy: public, factual, non-proprietary sources only. Respect robots.txt and ToS. No circumvention of access controls. Legal review per source.

---

## 9. Testing & quality

| Layer | Approach |
|---|---|
| Unit | Vitest (TS), `cargo test` (Rust). Property tests for AIS decoding and ledger invariants (debits = credits). |
| Contract | OpenAPI + JSON Schema in `/packages/schemas`. x402 conformance suite run against our gateway and against the policy SDK. |
| Integration | Testcontainers (Postgres, NATS). Anvil fork of Base for USDC/EIP-3009 flows. Base Sepolia end-to-end nightly. |
| Load | k6: 500 → 2 000 RPS paid, 10k RPS 402 challenges. Snapshot-build jitter under load. |
| Chaos / game days | Facilitator outage, AIS feed loss, NATS partition, Base RPC degradation, region failover |
| ERP | SAP/Oracle sandbox tenants from design partners. Reconciliation golden tests. |
| Scrapers | Golden responses, schema-drift alerts, canary jobs |

---

## 10. Cost & unit-economics model (to complete in M0)

| Line | Driver | Notes |
|---|---|---|
| AIS data licences | Fixed per year, by region/coverage | **Likely the largest cost.** Satellite AIS for Panama approaches is the most expensive. |
| Own receivers | Hardware + site leases (Kent coast) | Low capex, and gives us data we own for Dover |
| Facilitator fees | Per settled tx | Confirm current CDP pricing and free tier |
| Cloud | ECS, RDS, NATS, Grafana, Cloudflare | Estimated low thousands of £/month at launch |
| Compliance | ISO 27001/SOC 2 audit, pen tests, legal, accountant | Front-loaded in M0, M2 and M7 |
| **Break-even (A)** | Requests/month × avg price ≥ licence + infra | At 0.05 USDC average, every £10k/month of cost needs ~250k paid requests/month (before VAT and FX). |

---

## 11. Open questions (for this discussion)

1. **Rust for ingestion, or TypeScript everywhere?** (§3.1) Depends on who we hire.
2. **Cedar or OPA** for the policy language?
3. **VAT presentation for anonymous buyers:** VAT-inclusive (0.033 gross) or net + VAT?
4. **Settlement mode default:** verify-then-serve with async settle (fast, small credit risk) or settle-before-serve (slow, zero risk)? Recommendation: async with exposure caps.
5. **Product B pricing:** per-seat SaaS, % of x402 spend governed, or a flat platform fee + per-transaction fee?
6. **Which ERP first?** SAP is assumed. Is a design partner already on Oracle?
7. **Own AIS receivers in Kent?** Recommended for Dover licence independence. Needs site and hardware budget.
8. **Treasury policy:** convert USDC to GBP daily, or hold a USDC float for refunds and the fallback-facilitator gas?
9. **Design partners:** realistic first targets are mid-size shipping lines and forwarders. Amazon-scale buyers come after ISO 27001/SOC 2 and references. Agreed?
10. **Team & budget:** confirm headcount and runway against the 36-week path to GA.

---

## 12. Decision log (to be filled at approval)

| ID | Decision | Options | Recommendation | Owner | Status |
|---|---|---|---|---|---|
| D1 | Gateway language/framework | TS+Hono / Go | TS+Hono | n/a | Proposed |
| D2 | Ingestion language | Rust / TS | Rust | n/a | Needs decision |
| D3 | Bus | NATS / Redis Streams / Kafka | NATS JetStream | n/a | Proposed |
| D4 | Policy language | Cedar / OPA | Cedar | n/a | Needs decision |
| D5 | Cloud region | AWS London / other | AWS eu-west-2 | n/a | Proposed |
| D6 | Facilitator strategy | CDP only / CDP + self-hosted fallback | CDP + fallback | n/a | Proposed |
| D7 | Settlement mode | async / sync | async + caps | n/a | Needs decision |
| D8 | Custody model | non-custodial / custodial | non-custodial | n/a | Proposed (legal to confirm) |
| D9 | Anonymous VAT treatment | inclusive / exclusive | inclusive | n/a | Needs accountant |
| D10 | First ERP | SAP / Oracle | SAP | n/a | Needs partner input |
| D11 | Fiat payment rail | none / prepaid GBP credits / pay-in-arrears invoicing | Prepaid GBP credits (Stripe + bank transfer), our data only | n/a | **Approved**: implemented in the MVP (see MVP.md) |
