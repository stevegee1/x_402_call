# Architecture: Multi-Product x402 Platform

| | |
|---|---|
| **Status** | Draft for discussion. Not approved. |
| **Date** | 3 November 2026 |
| **Builds on** | [implementation.md](implementation.md) (plan), [MVP.md](MVP.md) (what exists today) |
| **Approval needed on** | §7 decisions, §8 migration order |

This document is for engineers and reviewers. It describes how the maritime MVP becomes a platform that carries several data or service products (maritime, a data-centre product for the Slough corridor, and later ones). All products share one payment path (x402 and fiat credits), one trust layer (sanctions and ERC-8004) and one ledger.

---

## 1. Summary

The four things we have been discussing sit at different levels:

| Item | Kind | Role in the platform |
|---|---|---|
| **x402** | Payment protocol | **Rail**: how a request is paid for |
| **ERC-8004** | On-chain agent registries (identity, reputation, validation) | **Trust**: who the counterparty is, and how far to trust it |
| **Maritime** | Vertical product | **Product**: AIS data and signals derived from it |
| **Data centre (Slough)** | Vertical product (shape to be decided, §6) | **Product**: data-centre data or metered compute |

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
│  ┌─ Maritime ──────────────┐  ┌─ Data centre ───────────┐  ┌─ Next product ─────┐       │
│  │ snapshot engine (250 ms)│  │ snapshot or job engine  │  │ …                  │       │
│  │ derive: density, queue, │  │ (see §6)                │  │                    │       │
│  │ anomalies               │  │                         │  │                    │       │
│  └───────────▲─────────────┘  └───────────▲─────────────┘  └────────────────────┘       │
└──────────────┼────────────────────────────┼────────────────────────────────────────────┘
               │ NATS  maritime.*           │ NATS  dc.*
        ┌──────┴──────┐              ┌──────┴──────┐
        │ ingest-ais  │              │ ingest-dc   │        Postgres: per-product history tables,
        │ (receivers, │              │ (BMS/DCIM,  │        shared payments, credits, ledger,
        │ aisstream)  │              │ grid feeds) │        trust cache
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

## 6. Data-centre product

**Open decision D-DC1:** what the data-centre product sells. The platform supports two shapes. The second needs new billing work.

### Option A: data-centre data (fits the platform as it is)

Examples: available power and capacity by site, grid connection constraints in the Slough corridor, cooling and PUE telemetry from partner operators.

- `ingest-dc` reads partner BMS/DCIM exports and grid operator feeds, then publishes to NATS `dc.*`.
- The product reuses the snapshot pattern (immutable, pre-serialised, a slower cadence such as 5 s to 60 s).
- `PricedResource.pricing.kind = "fixed"`. It needs no kernel changes beyond §3.
- **Licensing risk is the same as for AIS:** operator telemetry is usually under NDA. We need resale rights from each source before `mode=live`.

### Option B: metered compute or inference

Examples: GPU inference or batch jobs run on Slough capacity, paid per request by agents.

The cost varies and is only known when the request finishes, so the current `exact` scheme doesn't fit. It needs:

- **x402 `upto` (or an equivalent) scheme:** the buyer authorises a maximum, and we settle the actual amount. Check how mature `upto` is in `@x402/core` before committing. If it isn't ready, use prepaid credits only for this product at first.
- **A job engine in place of a snapshot:** submit, then poll or stream. Billing wraps job completion, not the HTTP response.
- **New invariant I11:** the amount settled is never more than the amount authorised, and the job's usage record supports the amount (it is journalled with the usage).
- **Policy SDK:** `maxPricePerRequestUsd` is checked against `maxUsd`, and budgets reserve `maxUsd` and release the difference after settlement.

**Option C** (Slough as our hosting location) is a deployment choice. It belongs in Terraform (implementation.md §3.3), not in this document.

**Recommendation:** start with Option A to prove the `Product` interface with a second vertical. Design the metered billing mode at the same time, because it is also what any future sub-cent product would need.

---

## 7. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D-P1 | One gateway hosting several products, or one service per product | One gateway until a product needs its own scaling (§8, step 5) |
| D-P2 | URL scheme | `/v1/{product}/{scope}/…`. Keep `/v1/{region}/…` as maritime aliases for one deprecation cycle. |
| D-P3 | One ERC-8004 identity for the platform, or one per product | One platform identity. Products are services in its agent card. |
| D-P4 | Credits spendable across all products | Yes. One balance, revenue split in the ledger. |
| D-DC1 | Data-centre product shape | Option A first; design Option B in parallel |
| D-T1 | Trust tiers affect exposure caps | Yes, after R4 is fixed. Tiers only loosen limits (§5.3). |

## 8. Migration plan

Each step ships on its own and keeps all existing tests green.

1. **Extract the kernel interface.** Add `Product`, `PricedResource` and `ResolvedScope`. Rewrite `paid()` to take a `Product` and a resource id. Wrap the current code as a `maritime` product. No behaviour change. Add a fake product to the e2e helpers and run the kernel invariants against it.
   *As built (`feat/platform-kernel`):* the kernel lives in `apps/gateway/src/platform/` and products in `apps/gateway/src/products/<id>/`, not yet in separate packages. A test enforces the import boundary instead (the kernel never imports a product; products import kernel modules as types only). Extract to `packages/` when a second deployable needs the kernel. Operator routes are per product under `/admin/<id>/…`, and the Panama draught route moved there without an alias, since admin is internal and not yet deployed.
2. **Namespace pricing and ledger.** Use `maritime.*` resource ids, revenue sub-accounts and `displayName` in Stripe. Add the `/v1/maritime/…` routes and keep the old ones as aliases.
3. **Fix R4.** Move exposure counters to Postgres (or Redis) so caps are global. Add the Testcontainers Postgres job in CI (R5) at the same time.
4. **Add `packages/identity`.** Seller agent card and registration, buyer policy rules (§5.2), then seller trust tiers (§5.3) behind a flag.
5. **Data-centre product, Option A.** Add `apps/ingest-dc` and `products/dc`. This is the first real test of the interface. Change the interface here if needed, before a third product depends on it.
6. **Metered billing** (if D-DC1 includes Option B): `upto` or credits-only, the job engine and I11.

Split a product into its own service only when it needs a different scaling profile, release cadence or team. The kernel is a package, so splitting doesn't need a rewrite.

### Target repo layout

```
/apps
  gateway/            # host: loads products, mounts kernel
  ingest-ais/         # was apps/ingest
  ingest-dc/          # new
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
  dc/                 # new
```

---

## 9. Open questions

1. Is `upto` (or batch settlement) in `@x402/core` ready for production use for Option B, or should metered products be credits-only at first?
2. Which ERC-8004 reputation aggregator or scoring method do we trust for tiers? Raw feedback counts are too easy to game.
3. Should we give buyers feedback authorisations after settlement (good for our reputation), and how do we stop that being used to build fake reputation?
4. Does selling data-centre data (Option A) need anything beyond each operator's resale terms, such as critical-infrastructure sensitivity in the UK?
5. VAT: does a second product change the place-of-supply analysis for anonymous x402 buyers (R9)? The accountant should review both products together.
