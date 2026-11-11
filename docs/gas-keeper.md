# Facilitator gas: pricing and the gas-keeper

Buyers pay with gasless x402 signatures. Someone still pays the gas to put each payment on chain:
the facilitator. When the facilitator is ours (`apps/facilitator`, the fallback on staging and
production), that gas comes from a hot wallet holding ETH. This page covers how prices pay for that
gas and how the wallet stays funded without a person topping it up.

## How prices pay for gas

Every per-call price includes a **network-fee allowance** of **$0.002** (USD on x402, **£0.002** on
credits, so both rails stay in step). It is defined once as `GAS_ALLOWANCE_USD` /
`GAS_ALLOWANCE_GBP_MICROS` in `packages/shared/src/pricing.ts` and was added to every price list
entry on 2026-11-11 (e.g. maritime vessels $0.033 to $0.035, grid intensity $0.01 to $0.012).

The allowance comes from measurement, not a guess:

```bash
pnpm gas:cost      # real settles to the staging PAY_TO, repriced at Base mainnet fees + Chainlink ETH/USD
```

On 2026-11-11 that measured 50 settles at **85.7k gas** each, **$0.00106** per settle at 0.006 gwei,
with the L1 data fee only 0.2% of the total. x402 prices include VAT, so of the $0.002 only
**$0.001666** is ours to spend on gas: about **1.57x** today's cost. The keeper alerts on the first tick (each minute) where the
live cost per settle passes that net figure. The x402
payment itself is unchanged: one `transferWithAuthorization` to `PAY_TO` for the exact list price.
The allowance lands in the treasury with the rest of the revenue.

## How the facilitator stays funded

`PAY_TO` (the treasury) is receive-only: its key is in no service. So the gas money moves through a
**float wallet** with a bounded balance:

```
treasury (PAY_TO) --(operator, by hand, e.g. $50 USDC)--> float wallet (gas-keeper's key)
float wallet --(gas-keeper: USDC -> ETH on Uniswap v3, then send)--> facilitator gas wallet
```

`apps/gas-keeper` checks once a minute (`INTERVAL_MS`). When the facilitator's balance is below
`TOPUP_TRIGGER_ETH` (0.003), it swaps just enough USDC to refill it to `TOPUP_TARGET_ETH` (0.01) and
to keep its own `KEEPER_RESERVE_ETH` (0.001) for its transactions, then sends the ETH. At today's
prices 0.01 ETH is about $20, enough for about 19,000 settles.

### Safety rails

| Rail | What it stops |
|---|---|
| Sends ETH only to `FACILITATOR_ADDRESS` | A bug or a bad config paying anyone else |
| Does nothing while one of its transactions is in flight (pending nonce above latest) | Swapping twice for one shortfall after a receipt timeout or a restart mid top-up |
| On SIGTERM it finishes only the transaction it is waiting on and starts no other: approve, swap, allowance reset and send are separate steps, each checked (exits within `SHUTDOWN_WAIT_MS`, 75 s, plus 5 s). A new deployment waits `START_DELAY_MS` (120 s; config refuses less than `SHUTDOWN_WAIT_MS` + 30 s in production) before its first tick | Two keepers acting at once during a deploy (Railway runs old and new side by side while the old one drains). A step slower than the wait is cut off; the next process waits for its transaction to mine before planning, so nothing is done twice |
| No nonce manager: each transaction takes its nonce from the node, one at a time | A dropped transaction wedging every later one |
| Router and feed addresses are code, not config (`src/addresses.ts`, each checked on chain) | Pointing the swap at a malicious contract |
| Exact approval per swap, reset after it; any leftover allowance is withdrawn at the start of every tick | A standing allowance the router could draw on later |
| Ceiling = Chainlink price + `MAX_SLIPPAGE_BPS` (1%); a worse quote is refused | Swapping into a thin or manipulated pool |
| Chainlink answer older than `PRICE_MAX_AGE_S` (30 min; the feed's heartbeat is 20 min) is refused | Trading on a stale price |
| No swaps while Base's sequencer is down or within an hour of it returning (Chainlink sequencer uptime feed; mainnet) | Trading on prices frozen by a sequencer outage |
| `MAX_USDC_PER_TOPUP` ($50) | One oversized swap |
| `MAX_USDC_PER_DAY` ($100). A swap counts at its ceiling while its outcome is unknown, at what it took once mined, and at 0 if it failed before broadcast or reverted. Failures are classified by phase (the keeper signs the swap itself, so anything after handing it to the node is "unknown") | A runaway loop inside one process. It is in memory, so a restart resets it |
| A top-up bigger than the tightest of the per-top-up cap, the day's remaining headroom and the float is sized down to fit (`gas_keeper_partial_topups_total`). A partial swap must deliver at least 10% of the need and buy at least half the reserve; if it can't, ETH the keeper already holds is sent instead (keeping half its reserve), and only if that is under 10% of the need is the top-up blocked | The facilitator running dry because one limit is slightly too small, or fees spent swapping for a few cents |
| The float balance itself | The hard ceiling on any loss, including a leaked key |
| Both wallets must be plain EOAs, checked at start and every tick | EIP-7702 sweeper delegations on a leaked key (they forward every top-up away) |
| One replica, one tick at a time | Two keepers topping up the same shortfall |

Each swap also buys the gas for its own transactions, so the keeper ends a top-up with its reserve.
If a top-up stops halfway (swap mined, then the send failed, its receipt timed out, or a deploy
stopped the process), the next tick waits for anything still in flight, withdraws any leftover
approval, and sends the ETH the keeper holds without swapping again: ETH in the keeper is sent
whenever it can be delivered leaving at least half the reserve. So a swap only happens when the
keeper would otherwise end below half its reserve, and every swap, full or partial, buys at least
half the reserve. `KEEPER_RESERVE_ETH` must be at least 0.0004, so the half a send may leave still
pays for a whole top-up's transactions up to about 0.33 gwei (55x today's gas price). Above that it
raises `keeper_gas_low`, holds off swapping, and still sends any ETH it already holds. Chainlink prices
outside $100 to $100,000 are treated as a broken feed (`price_invalid`).

`FACILITATOR_MIN_ETH` must match the facilitator's own `MIN_GAS_BALANCE_WEI`: set them together.
A restart can only lead to another swap if the facilitator has genuinely drained again.

The in-flight check trusts the RPC's pending nonce. Use a dedicated RPC provider in production
(`RPC_URL`): the public Base endpoints rate-limit bursts, and a load-balanced endpoint can answer
from a node that hasn't seen a just-sent transaction. A wrong answer can repeat the last step: a
second send over-funds the facilitator, a second swap leaves the extra ETH in the keeper (used by
later top-ups). Either costs fees, not funds; the per-top-up and daily caps still apply.

## Alerts and metrics

`gas-keeper` serves `/healthz` (process up), `/readyz` (ticks completing, active alerts) and
`/metrics` on the private network. Set `ALERT_WEBHOOK_URL` (e.g. a Slack incoming webhook) to be
told once per problem (retried until delivered). The balance alerts are checked on every tick
before anything else, so a stuck transaction or a failing step can't hide them:

| Alert | Meaning | Action |
|---|---|---|
| `facilitator_below_min` | The facilitator is under its own minimum and has stopped settling | Check the keeper's other alerts; top up by hand if needed |
| `topup_failing` | `FAIL_ALERT_TICKS` (3) ticks in a row failed (RPC, quote, revert, send) | Read the keeper's logs for the error |
| `tx_stuck` | A keeper transaction has been pending for 3 ticks | Usually gas price; check the transaction, replace it if needed |
| `float_low` | Float holds less than `FLOAT_LOW_USDC` ($10) | Move USDC from the treasury to the float wallet |
| `float_insufficient` | A top-up is needed and the float can't pay for it | Same, now |
| `keeper_out_of_gas`, `keeper_gas_low` | The keeper can't pay for a top-up's own transactions | Send it a little ETH |
| `startup_failed` | It refused to start: wrong chain id from `RPC_URL`, or a wallet with code | Fix the RPC, or treat the key as compromised |
| `quote_above_oracle` | The pool quotes worse than Chainlink + slippage | Usually transient; if it persists, check the pool |
| `price_stale` | Chainlink hasn't updated within `PRICE_MAX_AGE_S` | Transient on a healthy feed; check the feed if it persists |
| `sequencer_down` | Base's sequencer is down or just came back | Wait; swaps resume an hour after it is back |
| `exceeds_per_topup_cap`, `exceeds_daily_cap` | Caps reached | Check why gas use jumped before raising a cap |
| `wallet_has_code` | The keeper or facilitator address has code | Treat the key as compromised: move funds, rotate the key |
| `settle_cost_over_allowance` | One settle (L2 gas + L1 fee upper bound) costs more than the allowance net of VAT ($0.001666) | Gas has spiked about 1.6x; if it lasts, revisit the allowance |

Key metrics: `gas_keeper_settle_cost_usd` (live cost of one settle), `gas_keeper_facilitator_balance_gwei`,
`gas_keeper_float_usdc`, `gas_keeper_topups_total{result,kind}`, `gas_keeper_blocked_total{reason}`.
The facilitator reports what settles actually cost from their receipts:
`facilitator_settle_fee_gwei_total / facilitator_settle_fee_recorded_total` is the mean cost per settle.

## Setting it up

1. **Create the float key.** Staging: `pnpm staging:wallets` adds `x402-staging-gas-keeper` to the
   Keychain and prints its address. Production: generate it in your secrets manager. Never reuse a
   key that has been anywhere else.
2. **Fund the float**: a little ETH for its own gas (0.001 is plenty on Base), and USDC from the
   treasury ($50 is about 3 refills of 0.008 ETH at $2,000, ~45,000 settles).
3. **Set the secret** and deploy:
   ```bash
   security find-generic-password -s x402-staging-gas-keeper -a x402 -w \
     | railway variable set KEEPER_PRIVATE_KEY --stdin -s gas-keeper --skip-deploys
   ```
   Seal it in the dashboard, then deploy `gas-keeper`. The first log line names the keeper and
   facilitator addresses; `/readyz` turns 200 after the first tick.

## Tests

- `pnpm --filter @mx/gas-keeper test`: the planner, the keeper against a fake chain with a mempool
  (receipt timeouts, mined-later swaps, failed resets, stuck transactions), alerts, the run loop and
  its shutdown, and config validation. The chain adapter itself is covered by the fork test.
- `pnpm --filter @mx/gas-keeper test:fork`: the real adapter on an anvil fork of Base mainnet. Real
  Uniswap swap to native ETH, exact refill with the keeper's reserve intact, no leftover allowance,
  a leftover allowance withdrawn, the oracle guard refusing a real quote, the sequencer feed, and the
  EOA check refusing a real EIP-7702-delegated address. Needs `anvil` (Foundry 1.8.5).
