# How wearebase works

As of 4 November 2026.

## Summary

wearebase sells data one API call at a time, so a software agent can buy without an account, contract or person involved. An agent asks for data, is told the price with an HTTP 402 response, signs a USDC payment on Base, and gets the data back.

The gateway hosts two products: Grid (carbon intensity from NESO) and Maritime (vessel data). Businesses can also pay with prepaid GBP credits and an API key.

Today the app runs only on the Railway staging environment, on the Base Sepolia test network. No real money moves. Maritime serves simulated vessels, and the code refuses to charge for simulated data on mainnet.

## The parts of the system

The gateway is the centre of the app: buyers only ever talk to it, and it holds no wallet key. Buyers sign payments themselves, and a facilitator submits them to the chain.

```text
 Buyer agent          Business customer       Browser
 (signs USDC)         (GBP credits, API key)  (public page)
      |                      |                    |
      v                      v                    v
+---------------------------------------------------------+
| Gateway (the only public service)                       |
| Checks data is fresh, charges, serves data, settles.    |
| Hosts Grid and Maritime (simulator runs inside it).     |
| ERC-8004 tiers, sanctions screening, admin API.         |
+---------------------------------------------------------+
      |               |              |              ^
      v               v              v              |
 Facilitators      Postgres        NESO         Reconciler
 x402.org first,   payments,       Grid         compares ledger
 ours as fallback  ledger,         forecast,    with chain every
                   credits         10 min       15 minutes
      |                                             |
      v                                             v
+---------------------------------------------------------+
| Base Sepolia: USDC moves to the payment address here    |
+---------------------------------------------------------+
```

On staging, the gateway, our facilitator, the reconciler and Postgres run on Railway, in project `authentic-rebirth`. Our facilitator and the reconciler have no public address. `apps/ingest` and NATS are built but not deployed, and `apps/mcp` runs on the customer's machine.

## What happens when the gateway starts

The gateway checks everything it can before accepting a request, so a bad setup fails at boot rather than on a paid call. The order below is from `apps/gateway/src/server.ts`.

1. **Load config.** `config.ts` validates every environment variable and exits on an error. Production also requires `DATABASE_URL` and `ADMIN_TOKEN`, and refuses fixed FX rates.
2. **Open storage.** It runs the SQL migrations and connects to Postgres. Without `DATABASE_URL` it uses an in-memory store, for development only.
3. **Start Maritime.** It connects the feed (simulator or NATS), restores the saved Panama draught limit, and starts rebuilding snapshots every 250 ms by default.
4. **Start Grid, if `GRID_ENABLED` is true.** It fetches NESO once before serving, then polls every 10 minutes by default.
5. **Validate the catalog.** `Catalog` checks ids, prices and paths, and that every priced resource has exactly one handler.
6. **Set up payments.** It builds the primary and fallback facilitator clients, then pre-builds the payment requirements for every resource.
7. **Start the settlement worker.** It checks for payments due to settle every 500 ms.
8. **Set up trust checks.** This covers ERC-8004 tiers (if enabled) and sanctions screening.
9. **Set up credits.** Card top-ups stay off unless both Stripe keys are present.
10. **Listen.** Routes mount in a fixed order: public, credits, admin, then products, so a product path can never shadow a platform route.

On `SIGTERM` it stops taking requests and allows 1 second for settlements in flight. Anything unfinished is picked up again when its 60-second lease expires.

## How a buyer finds the data

Everything needed to discover and price the data is free; only the data calls cost money.

1. **Open `/`.** A browser gets the wearebase page. An agent or `curl` gets JSON at the same address, based on the `Accept` header.
2. **Read the catalog.** `/v1/products` lists products and prices, and `/openapi.json` describes the API. `/status` shows data freshness.
3. **Call a data endpoint without paying.** The gateway returns 402 with the price, the network and the address to pay. Nothing is stored or charged.

Agents can also connect through `apps/mcp`, an MCP server that runs on the customer's side. It holds their wallet key or API key, applies their budget limits from `packages/policy-sdk`, and currently covers Maritime.

| Endpoint | USDC per call (VAT included) | Credits per call (before VAT) |
| --- | --- | --- |
| `/v1/maritime/:region/vessels` | $0.035 | £0.027 |
| `/v1/maritime/:region/vessels/:mmsi` | $0.035 | £0.027 |
| `/v1/maritime/:region/density` | $0.035 | £0.027 |
| `/v1/maritime/:region/queue` | $0.068 | £0.052 |
| `/v1/maritime/:region/anomalies` | $0.068 | £0.052 |
| `/v1/grid/:country/intensity` | $0.012 | £0.010 |
| `/v1/grid/:country/forecast` | $0.022 | £0.017 |
| `/v1/grid/:country/window` | $0.052 | £0.042 |
| `/v1/grid/:country/history` | $0.052 | £0.042 |
| `/v1/grid/:country/revisions` | $0.022 | £0.017 |
| `/v1/grid/:country/stream` | $0.012 per event, session only | n/a |
| `/v1/sessions/usd1` | $1 | n/a |
| `/v1/sessions/usd5` | $5 | n/a |
| `/v1/sessions/usd20` | $20 | n/a |

Prices are generated from the live catalog (`/v1/products`, 16 November 2026), and include the network-fee allowance.

## A paid request, step by step

Normally the buyer gets the data first and the USDC moves about 2 seconds later, within a strict limit on how much can be unsettled. The logic is in `apps/gateway/src/payments/billing.ts`.

```text
1. Check the request     --> 404, 503, 400 or 422: no charge
   scope, freshness, parameters
        |
2. Look for a payment    --> no payment: 402 with the price
   PAYMENT-SIGNATURE, or an mk_ API key (credits path)
        |
3. Screen and verify     --> 403 blocked, 402 invalid, 503 unavailable
   sanctions, then facilitator
        |
4. Record the payment    --> reused nonce: 402 payment_already_used
        |
   Within exposure caps?
     | yes                         | no
     v                             v
5a. Serve, then settle         5b. Settle, then serve
    X-Settlement: pending          X-Settlement: settled
    failed handler cancels         buyer waits for the chain
     |                             |
     v                             v
6. USDC moves; status and ledger entry are saved together
```

What each step does:

1. **Sign.** The buyer reads the 402 and signs an EIP-3009 authorisation for the exact price. Signing moves no money by itself.
2. **Retry with the signature.** The buyer repeats the call with the `PAYMENT-SIGNATURE` header. An `mk_` API key takes the credits path instead.
3. **Verify.** The gateway confirms the signature matches the required amount, address and network, screens the wallet, then asks the facilitator to verify. If the primary is down, it fails over to our own facilitator.
4. **Admit.** Under a Postgres lock, it adds up all unsettled served value. The payment is served first only if it stays within the $25 total and the buyer's limit, otherwise it settles first.
5. **Settle.** The worker claims due payments with a 60-second lease, so replicas never process the same one twice. It retries up to 6 times with growing delays.
6. **Handle unknown outcomes.** If a facilitator times out, the gateway reads the USDC contract to see if the nonce was used. That single-use nonce means a payment can settle only once, even across both facilitators.
7. **Record.** A successful settlement saves the status and a GBP ledger entry in one transaction.

The buyer can check progress at `/v1/payments/:id`, using the id from the `X-Payment-Id` header.

## Paying with GBP credits

Credits are the second way to pay, for identified businesses that prepay in pounds. They spend across every product.

1. **Create an account.** `POST /v1/credits/accounts` takes company, email and country, and non-UK accounts must give a tax id. The API key is shown once and only its hash is stored.
2. **Top up.** Stripe sells packs of £20, £100 and £500, or an operator records a bank transfer through the admin API. Staging has no Stripe keys, so card top-ups are off there.
3. **VAT is charged at top-up.** UK customers pay 20%, and non-UK customers with a tax id are reverse charge. These rules are marked as needing accountant sign-off.
4. **Call the API.** Send `Authorization: Bearer mk_...`. The balance is debited before the handler runs, and refunded if the handler returns 400 or above.
5. **Run out.** An empty balance returns 402 with the current balance and a top-up link.

## Agent identity (ERC-8004)

A verified identity lets a buyer have more unsettled value at once; it never blocks anyone or changes the price. Any failure, such as a bad id or a registry timeout, falls back to Unknown.

The buyer sends `X-Agent-Id`. The gateway reads that agent's registered wallet and requires it to match the wallet that signed the payment. The lookup runs alongside payment verification and has a 1.5-second limit by default.

| Tier | How a buyer reaches it | Unsettled limit per wallet |
| --- | --- | --- |
| Unknown | Default | $1 |
| Identified | Registered wallet matches the payer | $2 |
| Trusted | Also at least 3 reviews averaging 80 or more, from approved reviewers | $5 |

The $25 limit across all buyers applies to every tier. Staging has no approved reviewers, so nobody can reach Trusted there yet.

## Where the data comes from

Grid is real data today and Maritime is simulated. Both follow the same rule: if the data is stale, the call returns 503 and nothing is charged.

**Grid**

1. The gateway fetches the NESO Country Carbon Intensity Forecast every 10 minutes and keeps it in memory.
2. It serves England, Scotland and Wales, and works out the current value, the forecast and the cleanest window for a job.
3. Data counts as fresh only if all of these hold: a fetch succeeded in the last 45 minutes, the current half-hour has a value, the forecast reaches at least 12 hours ahead, and it moved forward in the last 3 hours.
4. Every response carries the attribution the NESO licence requires.

**Maritime on staging**

1. A simulator inside the gateway generates about 60 vessels each for Dover, Rotterdam and Panama.
2. The snapshot engine rebuilds each region every 250 ms, and requests read the latest snapshot.
3. Each response is labelled `mode: simulated`, and the code refuses to sell non-live data on mainnet.

**Maritime with real data (built, not deployed)**

`apps/ingest` can read AIS from the simulator, UDP or TCP receivers, or aisstream.io. It removes duplicates, publishes to NATS for the gateway, and writes position history to the `ais_positions` table. Going live needs a data licence or our own receivers, plus NATS and this service on Railway.

## How the money is checked

The ledger and the blockchain are compared every 15 minutes, in both directions, so a missing or unexplained payment shows up on its own.

**The ledger.** Each settled payment or credit movement becomes a balanced double-entry record in GBP. Records are chained by hash, so editing an old one breaks the chain, and `/admin/ledger/verify` checks it. USDC is valued at the rate captured when the payment was admitted.

**The reconciler.** This separate service runs these steps:

1. Scan USDC transfers into the payment address, stopping 5 blocks short of the latest.
2. Read the payment address balance at that same block.
3. Fetch payments, the ledger CSV and the hash-chain result from the gateway admin API.
4. Report any mismatch: unrecorded transfers, settled payments with no transfer, wrong amounts, or missing ledger records.
5. Treat a problem as persistent if two runs in a row see it, and post it to a webhook if one is set.

**Operator tools.** All of these need `ADMIN_TOKEN`:

- `/admin/summary`: balances and current exposure
- `/admin/payments`: payment list
- `/admin/ledger.csv`: export for accounts
- `/admin/vat-summary`: draft VAT return figures

`/console` is the web page for these, and `/metrics` provides Prometheus metrics.

## How it is deployed and tested

Staging is defined in `.railway/railway.ts` and builds from the `feat/staging-railway` branch; there is no production environment yet.

1. **Build.** One Docker image serves every service, and each service redeploys only when its own files change.
2. **Configure.** `railway config apply` applies the file. It refuses any environment other than staging, and secrets are set separately.
3. **Deploy.** Railway waits for the health check, and allows 30 seconds for in-flight work when replacing a container.

CI runs four jobs on each pull request:

| CI job | What it runs | Tests at last full run |
| --- | --- | --- |
| `test` | Type checks and unit tests | 239 gateway, 33 facilitator, 23 reconciler |
| `integration` | The store against real Postgres 16 | 60 |
| `contracts` | Foundry tests of the mock contracts | 40 |
| `e2e` | Local chain, real facilitator, four gateway replicas | 26 |

Those counts come from the last full run during earlier work. The tests were not re-run for this review.

## Gaps found in this review

The biggest gap is that no real payment has gone through staging yet, and the code review found two ways a buyer can pay and get no data. The code findings come from reading the code and were not reproduced by running them. The `/metrics` and Grid rows come from checking staging on 4 November 2026.

| Gap | What happens | Fix |
| --- | --- | --- |
| No real staging payment yet | The payment path is proven locally, not on Base Sepolia | Fund the wallets and run the staging test |
| Retry after `settlement_pending` | The response says retry, but the same signed payment is then refused as `payment_already_used`, even if it settled | Return the data when the same payer and nonce already settled |
| Handler failure in sync mode | The buyer has already paid and gets no refund. A comment in the Grid code wrongly says billing refunds it | Refund, or fail only before settling; correct the comment |
| `/metrics` is public | Staging returns it without a token, including revenue and exposure figures | Require a token or block it at the edge |
| Sanctions screening has no data on staging | No denylist or Chainalysis key is set, and production config does not require one. An API failure also lets the payment through by default | Require screening in production and decide the failure rule |
| Signup limit can be bypassed | The limit trusts `cf-connecting-ip` and `x-forwarded-for`, and the repo's Railway config sets up no Cloudflare. It is also per replica | Use a trusted client IP and a shared limit |
| Grid could go stale falsely | Freshness expects new forecast periods within 3 hours. One staging reading showed nearly 2 hours without an advance | Measure how often NESO really advances |
| Maritime can take Grid down | With the NATS feed, a lost connection makes `/readyz` fail for the whole gateway | Keep product status out of gateway readiness |
| Reconciler restarts from the beginning | Its scan position is held in memory; the first run took about 9.5 minutes on a public RPC | Save the position and use a paid RPC |
| Database versions differ | Railway runs Postgres 18, while CI uses 16 | Test on 18 or pin the database |
| Legal and tax sign-off | VAT rules need an accountant, Maritime needs a data licence, and the name needs a trademark check | Owner decisions before mainnet |
