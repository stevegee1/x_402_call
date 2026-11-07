# Architecture: Multi-Product x402 Platform

| | |
|---|---|
| **Status** | Draft for discussion. Not approved. |
| **Date** | 3 November 2026 (§6 rewritten 7 November 2026) |
| **Builds on** | [implementation.md](implementation.md) (plan), [MVP.md](MVP.md) (what exists today) |
| **Approval needed on** | §7 decisions, §8 migration order |

This document is for engineers and reviewers. It describes how the maritime MVP becomes a platform that carries several data or service products (maritime, an environmental-data product for data-centre and trading buyers, and later ones). All products share one payment path (x402 and fiat credits), one trust layer (sanctions and ERC-8004) and one ledger.

---

## 1. Summary

The four things we have been discussing sit at different levels:

| Item | Kind | Role in the platform |
|---|---|---|
| **x402** | Payment protocol | **Rail**: how a request is paid for |
| **ERC-8004** | On-chain agent registries (identity, reputation, validation) | **Trust**: who the counterparty is, and how far to trust it |
| **Maritime** | Vertical product | **Product**: AIS data and signals derived from it |
| **Environmental data (data centre)** | Vertical product (§6) | **Product**: cleaned environmental time series with point-in-time history, served in milliseconds |

**Target shape:** one platform kernel with horizontal layers (billing, settlement, ledger, trust, buyer policy), and vertical products that plug into it through one `Product` interface. Each product owns its ingest pipeline and its handlers. No product touches money or trust code directly.

**Not in scope:** separate deployables per product. We stay with one gateway process that hosts several products until a product has a real reason to scale or deploy on its own (§8, step 5).

---

## 2. Layer diagram

```
                Buyers: AI agents · MCP clients · B2B integrations
                                     │
                       ┌─────────────┴──────────────┐
                       │  Buyer side (customer-run) │
                       │  policy SDK · MCP server   │   budgets, allowlists, breakers,
                       │  trust checks (ERC-8004)   │   ERP accrual export
                       └─────────────┬──────────────┘
                                     │  HTTPS: 402 challenge / PAYMENT-SIGNATURE / Bearer mk_…
┌────────────────────────────────────┼───────────────────────────────────────────────────┐
│ Gateway (one process, N replicas)  ▼                                                   │
│                                                                                        │
│  ┌─ Platform kernel ───────────────────────────────────────────────────────────────┐   │
│  │ Router ─► product.resolve() ─► freshness/mode gate ─► precheck ─► billing ─► handler │
│  │                                                                                  │   │
│  │ Billing:  x402 (exact; metered later) · credits · 402 advertisement             │   │
│  │ Risk:     exposure caps (sized by trust tier) · facilitator breaker + fallback  │   │
│  │ Trust:    sanctions screen · ERC-8004 identity/reputation/validation lookup     │   │
│  │ Money:    settlement worker · double-entry hash-chained ledger · VAT · HMRC CSV │   │
│  │ Ops:      metrics · status · OpenAPI · console · agent card                     │   │
│  └───────────────────────────────────▲─────────────────────────────────────────────┘   │
│                                      │ Product interface (§3)                          │
│  ┌─ Maritime ──────────────┐  ┌─ Grid (environmental) ──┐  ┌─ Next product ─────┐       │
│  │ snapshot engine (250 ms)│  │ latest version in memory│  │ …                  │       │
│  │ derive: density, queue, │  │ as-of reads from store  │  │                    │       │
│  │ anomalies               │  │ (see §6)                │  │                    │       │
│  └───────────▲─────────────┘  └───────────▲─────────────┘  └────────────────────┘       │
└──────────────┼────────────────────────────┼────────────────────────────────────────────┘
               │ NATS  maritime.*           │ NATS  env.*
        ┌──────┴──────┐              ┌──────┴──────┐
        │ ingest-ais  │              │ ingest-env  │        Postgres: per-product history tables,
        │ (receivers, │              │ (NESO, every│        shared payments, credits, ledger,
        │ aisstream)  │              │  version)   │        trust cache
        └─────────────┘              └─────────────┘

External: x402 facilitator (CDP + self-hosted fallback) · Base (USDC → Safe) · Stripe ·
          ERC-8004 registries on Base · Chainalysis
```

Rule: **arrows into the kernel go through the `Product` interface only.** The kernel never imports from a product package. Products never import billing, ledger or trust internals.

---

## 3. The Product interface

Today [billing.ts:47-61](apps/gateway/src/payments/billing.ts#L47-L61) reads `:region`, calls `isRegionId` and checks `RegionSnapshot.stale` and `.mode`. [pricing.ts](packages/shared/src/pricing.ts) has a closed `EndpointId` union of maritime endpoints. These are the only places where maritime ideas reach the kernel. The gate logic itself is general ("is the data fresh?", "is it live?", "does the resource exist?"), so we keep it and move the maritime details behind an interface.

```ts
// apps/gateway/src/platform/product.ts (see §8 step 1: in-app for now, package later)
export interface PricedResource {
  id: string;                 // "maritime.vessels", "dc.capacity"; namespaced by product
  method: "GET" | "POST";
  path: string;               // Hono pattern, mounted under /v1/{product}/…
  description: string;
  pricing:
    | { kind: "fixed"; priceUsd: string; creditsGbpMicros: number }
    | { kind: "metered"; maxUsd: string; maxCreditsGbpMicros: number; unit: string }; // §6, option B
}

export interface ResolvedScope {
  scope: string;              // "dover", "slough-1"; used for metrics, ledger memo, exposure
  fresh: boolean;             // false → 503, never charged (invariant I1)
  mode: "live" | "simulated" | "replay"; // non-live on mainnet → 503 (invariant I2)
  sourceTs?: number;
  state: unknown;             // product-owned; handed to precheck and handler unchanged
}

export interface Product {
  id: string;                                  // "maritime", "dc"
  displayName: string;                         // used in Stripe line items, console, agent card
  resources: PricedResource[];
  /** Map a request to the data it will read. Return a Response for unknown scope (404, never charged). */
  resolve(c: Context): ResolvedScope | Response;
  /** Cheap check that must pass BEFORE charging (invariant I5). */
  precheck?(c: Context, s: ResolvedScope): Response | null;
  /** Register handlers. Each handler is wrapped by kernel billing for its resource id. */
  routes(app: ProductRouter): void;
  /** Free endpoints: status, metadata. */
  status(): ProductStatus;
}
```

The kernel builds the route table, the 402 advertisement, OpenAPI, `/v1/status`, the console and the ERC-8004 agent card from `Product.resources`. Prices stay in config, as the plan requires. `PricedResource` values are loaded from each product's config, not hard-coded.

**What stays the same for every product, with no extra code:** I1 (no charge for stale data), I2 (no simulated data on mainnet), I3 (replay protection), I4 (bounded exposure), I5 (no charge on failure), I6 (facilitator outage → 503), I8 (ledger integrity), I9 (credits never negative). The existing e2e tests become kernel tests run against a small fake product, plus product tests for maritime.

---

## 4. Platform kernel

### 4.1 Request path (all products)

```
route match → product.resolve() → fresh? live-on-mainnet? → product.precheck()
   → trust: sanctions(payer) + trustTier(payer)
   → billing: credits | x402 verify | 402
   → exposure: async if under tier cap, else sync settle
   → handler → (≥400 → refund / cancel) → response
   → settlement worker → ledger journal (memo carries product + scope)
```

This is the MVP order with two additions: `product.resolve()` replaces `engine.get(region)`, and the trust step returns a tier as well as a pass/fail.

### 4.2 Money

- **Ledger:** one chart of accounts. Revenue is split by product sub-account (`revenue:maritime`, `revenue:dc`) so the close pack and VAT returns can report per product. The hash chain and advisory lock stay global (R8 still applies).
- **Credits:** one balance per account, spendable on any of our products. This is still prepayment for our own services, so the non-custodial position in implementation.md §8.2 does not change. Because a top-up isn't for any one product, the Stripe line item is product-neutral ("API credits: <pack>"), not a product's display name.
- **x402:** one `PAY_TO` Safe for all products. We attribute revenue by resource id in our own records, not by wallet.

### 4.3 Risk

[exposure.ts](apps/gateway/src/payments/exposure.ts) uses one per-payer cap. It becomes a cap per trust tier (§5.3). The global cap is unchanged. R4 (per-replica counters) has to be fixed before tiered caps go live, because a high tier multiplied by N replicas is a much larger loss bound.

---

## 5. Trust layer: ERC-8004

ERC-8004 defines three on-chain registries: **Identity** (an agent ID that points to an agent card), **Reputation** (feedback from counterparties) and **Validation** (third-party checks, such as re-execution, TEE or zk attestations). Re-confirm the spec version and the Base deployment addresses at kickoff, as we do for x402.

New package: `packages/identity`. It is used on both sides.

### 5.1 Seller identity (gateway)

- Register the platform as one agent in the Identity Registry. Each product is listed as a service in the agent card, so we keep one reputation instead of splitting it across products.
- The agent card is generated from `Product.resources`. It lists endpoints, x402 prices and networks, the MCP manifest and the credits alternative.
- After a successful settlement, the gateway may give the buyer an authorisation to leave feedback. Whether we do this is open question Q3.

### 5.2 Buyer-side trust (policy SDK)

New optional policy rules in [policy.ts](packages/policy-sdk/src/policy.ts), evaluated before signing:

```ts
counterparty?: {
  requireIdentity: boolean;          // seller must have an 8004 ID that resolves to this origin
  minReputation?: number;            // score from a reputation aggregator we choose (Q2)
  requiredValidators?: string[];     // e.g. a named validator must have attested
}
```

New deny codes: `counterparty_unidentified`, `counterparty_reputation_low`, `counterparty_not_validated`. Lookups are cached with a TTL. If the registry or RPC is unreachable, the decision is controlled by policy: `fail_closed` (default for enterprises) or `fail_open`. This is the "EAS attestation checks" item in M6, built on ERC-8004 instead of, or as well as, EAS.

### 5.3 Seller-side trust tiers (gateway)

The payer's address is resolved to an 8004 identity where one exists. The result sets the exposure cap and settlement mode:

| Tier | Condition | Per-payer async cap | Notes |
|---|---|---|---|
| `blocked` | Sanctions hit | n/a | 403, never served |
| `unknown` | No identity | $0, so always sync | Slower (one Base block), no credit risk |
| `identified` | Identity, no or low reputation | $1 (today's default) | |
| `trusted` | Reputation ≥ threshold or named validator | $10 | Sized after R4 is fixed |

**Limits on trust:** registering a new identity costs almost nothing, so reputation is open to Sybil attacks. A tier can only **loosen** latency and exposure limits. It never skips sanctions screening, the mainnet gate or replay protection. The worst case for a fake `trusted` identity is one tier cap, which is bounded and appears in the exposure metrics.

The tiers address R1 (async serving before settlement) without making every unknown buyer pay the sync latency cost for ever. Building reputation gives agents a reason to come back.

---

## 6. Data-centre product: environmental data

**D-DC1 is decided (7 November 2026):** the data-centre product sells **cleaned environmental time series**, starting with NESO grid data. We publish no partner telemetry and no metered compute. Option B (GPU or batch jobs paid per request) is deferred. Its design notes are kept at the end of this section in case it comes back.

### 6.1 Who buys it and what they need

The target buyers are systematic trading firms and other model-driven buyers. One example is an algorithmic market maker that forecasts prices for tens of thousands of instruments, including power, gas and carbon. Data-centre operators who schedule workloads around grid carbon are a second, smaller group. Grid already serves them.

These buyers need three things, and the design follows from them:

1. **History as it was known at the time.** A backtest has to see what the forecast said *then*, not what it says now. NESO overwrites each half-hour's row in place: the resource declares `datastore_unique_keys: ["datetime"]` with `datastore_append_or_update: true`, so upstream keeps no old versions. **Every published version we store becomes data that exists nowhere else.** Each day we don't ingest is a day of history we can't recover.
2. **Fast delivery of each new version.** No one can get the data faster than NESO publishes it, which is every 30 to 60 minutes. What we control is the gap between NESO publishing and the buyer holding the data. We measure that gap (`ingested_at − published_at`, plus our serve time) and keep it small.
3. **Fast, predictable reads** with a stable schema and quality flags. The target is p99 < 5 ms for a point or recent-range read, from inside the same region.

### 6.2 Pipeline

```text
NESO Data Portal ──resource_show every 30 s; full fetch when last_modified moves, else every 10 min──►
  apps/ingest-env  (own service: an upstream fault never touches the gateway)
     1. clean   UTC half-hours aligned to the period; values range-checked; every value tagged
                ok / missing / rejected (the rejected raw value kept for audit); nothing interpolated
     2. diff    against the latest stored version of each (dataset, region, period), under a
                per-dataset advisory lock, so replicas never write a change twice
     3. append  only what changed, stamped with ingested_at (our clock) and published_at (NESO's)
     4. log     every fetch, failed ones included, in env_fetch: proof of when we were watching
        │
        ▼
  Postgres env_observation  (append-only; a TimescaleDB hypertable on valid_from when the
                             extension is available, a plain table otherwise; same queries)
        │
        ├── pg_notify('env_version') on commit ──► gateway EnvCache: every version of the recent
        │          window in memory (7 days by default), followed by seq; 15 s fallback poll
        ├── REST: live endpoints, /history?from&to&as_of and /revisions?period, from memory
        │          (older history from Postgres, same answers)
        ├── [PR 2b] SSE push of each new version, paid with an x402 session
        └── [PR 5] nightly Parquet export of the full version history, for bulk backtests
```

### 6.3 Storage model

`env_observation` has one row for each change to one value: `(dataset, region, valid_from, ingested_at)` → `value`, `unit`, `quality`, `raw_value`, `published_at`.

- **Point-in-time reads use `ingested_at`, not `published_at`.** We certainly knew a value at `ingested_at`. NESO's `last_modified` can come before the data was actually readable, so filtering on it could let a backtest see data a little before anyone could have had it. `published_at` is kept to show where latency comes from.
- **Rows are only appended, never changed.** Triggers block `UPDATE`, `DELETE` and `TRUNCATE`, as on the ledger. An as-of query for a given `T` therefore returns the same answer for ever.
- **Only changes are written.** A period's first row is the moment we first saw it, so an as-of query never returns a period that hadn't been forecast yet at `T`. When data is absent from a fetch we treat that as no information, not as a deletion, because we only fetch the forward window.
- **History starts at the first ingest.** Older NESO values carry no knowledge time, so we don't backfill them as point-in-time data.
- **Settlement periods** (46 or 50 per day on clock-change days) come from `valid_from` when data is read. Storage stays in uniform UTC.

### 6.4 Latency and billing

- **Hot path in memory.** Reads of the latest version and recent history never touch Postgres. As-of reads over older history do, and use the primary key `(dataset, region, valid_from, ingested_at)`.
- **Change delivery uses Postgres `LISTEN/NOTIFY`, not NATS.** The notification is sent inside ingest's write transaction, so it arrives only after commit and never before the data can be read. It needs no new infrastructure. A notification only says "look". The cache then reads by `seq` (migration 005), which writers assign under the per-dataset lock, so commit order is seq order and nothing is skipped. Missed notifications cost at most the 15 s fallback poll. NATS is worth adding when many consumers outside the gateway need the stream.
- **Measured (PR 2a).** In-process through the whole gateway (routing, credits billing, handler, JSON), p99 is 0.3–1.7 ms. Over real HTTP on one machine, a paid read is ~3.5–3.9 ms at p50, of which ~1 ms is the client and connection and most of the rest is the per-call credits debit in Postgres. **Billing, not data, is now the cost.**
- **Measured (PR 2b).** On the session rail, in-process p99 is 0.37 ms for the intensity read and 1.5 ms for a 50 h as-of history read. No database, chain or facilitator is on the path.
- **Session accounting** (accountant sign-off needed before mainnet, like the other VAT rules):

  | Event | Booking |
  |---|---|
  | Purchase (settled) | Dr USDC wallet, Cr `liability:session_prepaid` (net), Cr VAT output |
  | Each usage report | Dr the liability, Cr `revenue:<product>`. The total released is always floor(net × spent / amount), so rounding can't drift |
  | Expiry plus 2 min grace | the rest of the liability goes to `revenue:session_breakage` |

  The session is derived from its payment, so a buyer holding a token always has the balance.
- **Session failure bounds.** If a replica crashes, it loses its unreported spend: that revenue lands in breakage instead, so the total is the same. It also strands at most one lease (`SESSION_LEASE_USD`, default $0.25) per session until expiry. Neither failure can let a buyer spend more than they paid (I13).
- **Making the billing fast while keeping x402.** Each x402 call is verified by an HTTP request to the facilitator, which costs tens to hundreds of milliseconds, and a trading firm won't sign an authorisation per tick. So:
  1. **Sessions (PR 2b).** One payment (an x402 payment, or a credits debit) buys a short-lived session token tied to the payer and worth an amount or a stream. Each read checks an HMAC and debits an in-memory balance. Usage is journalled in batches. No facilitator call, no chain and no database on the read path.
  2. **Push (PR 2b).** An SSE stream, paid with a session, sends each new version as soon as it commits.
  3. **Optimistic per-call x402 (PR 3).** The gateway verifies the EIP-3009 signature itself and settles in the background. Each replica admits within its own share of the exposure caps in memory, with an in-memory nonce guard. It gets its own review because it changes the risk model.
- **Hosting.** Network distance dominates. The London trading data centres cluster in Slough, so production for this product runs in London (eu-west-2). Railway stays the staging environment.

### 6.5 Delivery, one PR each

1. **`apps/ingest-env` + `packages/env` + `env_observation`:** store every version of NESO carbon intensity, and add the store's as-of read functions. *(Done: `feat/env-history`.)*
2. **2a, hot path:** the gateway follows the store in memory (`GRID_SOURCE=store`), adds `grid.history` and `grid.revisions`, and runs latency budgets in CI. *(Done: `feat/env-hot-path`.)*
   **2b, sessions and push:** x402 buys a session (sync settlement, liability until spent); reads are in-memory debits on leased balance; SSE push paid per event. *(Done: `feat/x402-sessions`.)* Funding a session with GBP credits is a follow-up.
3. **Optimistic per-call x402:** local EIP-3009 verification, in-memory admission per replica.
4. **More datasets:** embedded wind and solar forecast, demand forecast, generation mix. Each is a new `DatasetSpec`, not a new pipeline.
5. **Bulk history:** nightly Parquet export.

### 6.6 Deferred: metered compute (former Option B)

The cost of a GPU or batch job is only known when the job finishes, so the `exact` scheme doesn't fit. Metered compute would need x402 `upto` (or prepaid credits only), a job engine in place of a snapshot, a new invariant I11 (settled ≤ authorised, backed by a journalled usage record), and policy-SDK budgets that reserve `maxUsd` and release the difference after settlement.

---

## 7. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D-P1 | One gateway hosting several products, or one service per product | One gateway until a product needs its own scaling (§8, step 5) |
| D-P2 | URL scheme | `/v1/{product}/{scope}/…`. Keep `/v1/{region}/…` as maritime aliases for one deprecation cycle. |
| D-P3 | One ERC-8004 identity for the platform, or one per product | One platform identity. Products are services in its agent card. |
| D-P4 | Credits spendable across all products | Yes. One balance, revenue split in the ledger. |
| D-DC1 | Data-centre product shape | **Decided 7 Nov 2026:** cleaned environmental time series from NESO (§6). Metered compute deferred. |
| D-T1 | Trust tiers affect exposure caps | Yes, after R4 is fixed. Tiers only loosen limits (§5.3). |

## 8. Migration plan

Each step ships on its own and keeps all existing tests green.

1. **Extract the kernel interface.** Add `Product`, `PricedResource` and `ResolvedScope`. Rewrite `paid()` to take a `Product` and a resource id. Wrap the current code as a `maritime` product. No behaviour change. Add a fake product to the e2e helpers and run the kernel invariants against it.
   *As built (`feat/platform-kernel`):* the kernel lives in `apps/gateway/src/platform/` and products in `apps/gateway/src/products/<id>/`, not yet in separate packages. A test enforces the import boundary instead (the kernel never imports a product; products import kernel modules as types only). Extract to `packages/` when a second deployable needs the kernel. Operator routes are per product under `/admin/<id>/…`, and the Panama draught route moved there without an alias, since admin is internal and not yet deployed.
2. **Namespace pricing and ledger.** Use `maritime.*` resource ids, revenue sub-accounts and `displayName` in Stripe. Add the `/v1/maritime/…` routes and keep the old ones as aliases.
3. **Fix R4.** Move exposure counters to Postgres (or Redis) so caps are global. Add the Testcontainers Postgres job in CI (R5) at the same time.
4. **Add `packages/identity`.** Seller agent card and registration, buyer policy rules (§5.2), then seller trust tiers (§5.3) behind a flag.
5. **Data-centre product, Option A.** Add `apps/ingest-dc` and `products/dc`. This is the first real test of the interface. Change the interface here if needed, before a third product depends on it.
   *As built:* `products/grid` (`feat/grid-product`) proved the interface with NESO carbon intensity polled inside the gateway. §6 replaces the in-gateway poll with `apps/ingest-env`, `packages/env` and the version store. See §6.5 for the order.
6. **Metered billing:** deferred with metered compute (§6.6). The low-latency credits or subscription path (§6.4) comes first.

Split a product into its own service only when it needs a different scaling profile, release cadence or team. The kernel is a package, so splitting doesn't need a rewrite.

### Target repo layout

```
/apps
  gateway/            # host: loads products, mounts kernel
  ingest-ais/         # was apps/ingest
  ingest-env/         # environmental data versions (§6)
  mcp/                # tools generated from product resources
/packages
  platform/           # Product interface, billing, settlement, exposure, facilitator
  ledger/             # journal, VAT, FX, HMRC export (from apps/gateway/src/ledger)
  credits/            # accounts, keys, checkout (from apps/gateway/src/credits)
  identity/           # ERC-8004 registries, agent card, trust tiers
  policy-sdk/         # buyer side; gains counterparty rules
  shared/             # money, geo, common types
/products
  maritime/           # snapshot engine, derive, regions, routes (from gateway + packages/ais)
  grid/               # environmental data product (§6); reads packages/env
```

---

## 9. Open questions

1. Is `upto` (or batch settlement) in `@x402/core` ready for production use for Option B, or should metered products be credits-only at first?
2. Which ERC-8004 reputation aggregator or scoring method do we trust for tiers? Raw feedback counts are too easy to game.
3. Should we give buyers feedback authorisations after settlement (good for our reputation), and how do we stop that being used to build fake reputation?
4. Which subscription shape suits trading buyers (§6.4): a flat monthly entitlement per dataset, or prepaid credits drawn per read?
5. VAT: does a second product change the place-of-supply analysis for anonymous x402 buyers (R9)? The accountant should review both products together.
