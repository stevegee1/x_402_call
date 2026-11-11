import { GAS_ALLOWANCE_USD, SETTLE_GAS_UNITS, usdToUsdcAtomic } from "@mx/shared";
import type { Address, Hex } from "viem";

/** What the keeper needs from the chain; src/chain.ts implements it over viem, tests fake it. */
export interface KeeperChain {
  /** The keeper (float) wallet. */
  readonly address: Address;
  ethBalance(who: Address): Promise<bigint>;
  /**
   * Whether an address has code. Both wallets must be plain EOAs: an EIP-7702 delegation (as sweeper
   * bots set on leaked keys) or a contract could forward every top-up somewhere else.
   */
  hasCode(who: Address): Promise<boolean>;
  /**
   * Whether the keeper has a transaction broadcast but not yet mined (pending nonce above latest).
   * Balances read while one is in flight are stale, so the keeper must not plan on them.
   */
  hasPendingTx(): Promise<boolean>;
  /** USDC held by the keeper wallet, atomic (6 dp). */
  usdcBalance(): Promise<bigint>;
  /** Chainlink ETH/USD: answer with 8 decimals, and when it was last updated (unix seconds). */
  ethUsd(): Promise<{ priceE8: bigint; updatedAt: number }>;
  /** Chainlink L2 sequencer uptime, where the network has a feed (null otherwise). */
  sequencer(): Promise<{ up: boolean; sinceS: number } | null>;
  gasPriceWei(): Promise<bigint>;
  /** Upper bound on the L1 data fee of one settle-sized transaction (OP-stack GasPriceOracle). */
  settleL1FeeWei(): Promise<bigint>;
  /** USDC (atomic) the pool asks for exactly `ethOutWei` of ETH. */
  quoteUsdcForEth(ethOutWei: bigint): Promise<bigint>;
  /** USDC allowance the keeper has granted the router. */
  routerAllowance(): Promise<bigint>;
  /** Sets the router allowance to 0; resolves once mined. */
  resetAllowance(): Promise<Hex>;
  /** Approves the router for exactly `usdcMax` (never unlimited); resolves once mined. */
  approveRouter(usdcMax: bigint): Promise<Hex>;
  /**
   * Swaps at most `usdcMax` USDC (already approved) for exactly `ethOutWei` ETH, delivered to the
   * keeper as native ETH. Resolves once mined. Throws a SwapError saying whether the swap could
   * have reached the chain. Returns the USDC it took (from its own Transfer logs). Leaves any unspent
   * allowance for the caller to reset.
   */
  swapUsdcForEth(ethOutWei: bigint, usdcMax: bigint): Promise<{ tx: Hex; usdcSpent: bigint }>;
  /** Sends native ETH; resolves once mined, throws on revert. */
  sendEth(to: Address, valueWei: bigint): Promise<Hex>;
}

export interface Limits {
  facilitator: Address;
  /** The facilitator turns not-ready below this (its MIN_GAS_BALANCE_WEI): alert when it gets there. */
  facilitatorMinWei: bigint;
  triggerWei: bigint;
  targetWei: bigint;
  keeperReserveWei: bigint;
  maxUsdcPerTopup: bigint;
  maxUsdcPerDay: bigint;
  maxSlippageBps: number;
  priceMaxAgeS: number;
  floatLowUsdc: bigint;
  /** Consecutive failed or stuck ticks before alerting. */
  failAlertTicks: number;
}

export interface Snapshot {
  facilitatorWei: bigint;
  keeperWei: bigint;
  keeperUsdc: bigint;
  priceE8: bigint;
  priceUpdatedAt: number;
  gasPriceWei: bigint;
  /** null on networks without a sequencer feed. */
  sequencer: { up: boolean; sinceS: number } | null;
  /** L1 data fee upper bound for one settle-sized transaction (also used for the keeper's own transactions). */
  l1FeeWei: bigint;
  /** USDC this process has spent (or may have spent) on swaps in the last 24 h. */
  spentDayUsdc: bigint;
}

/**
 * Generous gas for one top-up's own transactions (approve, swap+unwrap, allowance reset, send).
 * The keeper won't start one it can't pay for, and swaps this much extra so it ends a top-up with
 * its reserve intact.
 */
export const TOPUP_GAS_UNITS = 600_000n;
/** Transactions in one top-up (approve, swap, reset, send), each paying an L1 data fee. */
const TOPUP_TXS = 4n;
/**
 * Bytes of a signed settle (USDC transferWithAuthorization: 4 + 9 x 32 calldata, plus envelope and
 * signature), which settleL1FeeWei prices, and of the keeper's largest transaction, the swap multicall.
 */
export const SETTLE_TX_BYTES = 410n;
const KEEPER_TX_BYTES = 700n;
/** Sanity band for Chainlink ETH/USD ($100 to $100,000). */
const PRICE_MIN_E8 = 100n * 10n ** 8n;
const PRICE_MAX_E8 = 100_000n * 10n ** 8n;
/** Gas for a plain ETH transfer. */
const SEND_GAS_UNITS = 21_000n;
/** A partial top-up must deliver at least 1/10 of what the facilitator needs. */
const MIN_PARTIAL_DIVISOR = 10n;
/** After the sequencer comes back, Chainlink advises waiting before trusting prices again. */
export const SEQUENCER_GRACE_S = 3600;
export const DAY_MS = 86_400_000;
/** UK VAT: x402 prices are VAT-inclusive, so only 1/1.2 of the allowance is ours to spend on gas. */
const VAT_DIVISOR_BPS = 12_000n;
/** The network-fee allowance in each price, net of VAT: what one settle may cost before we lose money. */
export const GAS_ALLOWANCE_NET_USDC = (usdToUsdcAtomic(GAS_ALLOWANCE_USD) * 10_000n) / VAT_DIVISOR_BPS;

export type BlockReason =
  | "price_stale"
  | "price_invalid"
  | "sequencer_down"
  | "keeper_out_of_gas"
  | "exceeds_per_topup_cap"
  | "exceeds_daily_cap"
  | "float_insufficient"
  | "quote_above_oracle"
  | "wallet_has_code";
const BLOCK_REASONS: readonly BlockReason[] = [
  "price_stale",
  "price_invalid",
  "sequencer_down",
  "keeper_out_of_gas",
  "exceeds_per_topup_cap",
  "exceeds_daily_cap",
  "float_insufficient",
  "quote_above_oracle",
  "wallet_has_code",
];

export type Plan =
  | { kind: "idle" }
  /** Enough ETH already sits in the keeper (e.g. a previous run swapped, then failed to send): just send it. */
  /** `blockedBy`: a swap was needed but refused; this sends held ETH instead, and the reason stays alerted. */
  | { kind: "send"; toFacilitatorWei: bigint; blockedBy?: Blocked }
  /**
   * Swap `ethOutWei` (facilitator top-up, keeper reserve and this top-up's own gas), paying at most
   * `usdcMax`, then send. `fallbackSendWei`: held ETH to send instead if the quote is refused or fails.
   */
  | { kind: "swap"; toFacilitatorWei: bigint; ethOutWei: bigint; usdcMax: bigint; oracleUsdc: bigint; partial: boolean; fallbackSendWei: bigint | null }
  | Blocked;
type Blocked = { kind: "blocked"; reason: BlockReason; detail: Record<string, string> };

/** USDC (atomic, 6 dp) worth `wei` of ETH at a Chainlink price with 8 decimals, rounded up. */
export function usdcForWei(wei: bigint, priceE8: bigint): bigint {
  const den = 10n ** 20n; // 1e18 wei * 1e8 price / 1e6 usdc
  return (wei * priceE8 + den - 1n) / den;
}

/** The largest ceiling (USDC) for `wei` of ETH: oracle price plus the slippage band. */
const ceilingFor = (wei: bigint, priceE8: bigint, slippageBps: number) => {
  const oracleUsdc = usdcForWei(wei, priceE8);
  return { oracleUsdc, usdcMax: (oracleUsdc * BigInt(10_000 + slippageBps)) / 10_000n };
};

/**
 * Decides one tick. Pure: same snapshot, same plan. The check that needs a live quote happens in
 * checkQuote once the plan says a swap is needed.
 */
export function plan(s: Snapshot, l: Limits, nowMs: number): Plan {
  const toFacilitatorWei = s.facilitatorWei < l.triggerWei ? l.targetWei - s.facilitatorWei : 0n;
  const keeperLow = s.keeperWei < l.keeperReserveWei / 2n;
  if (toFacilitatorWei === 0n && !keeperLow) return { kind: "idle" };

  // ETH already in the keeper is sent when it can be delivered leaving at least half the reserve
  // (the same line that triggers a reserve refill). This is the recovery path after a swap mined but
  // its send didn't happen: the keeper's own gas for that swap must not be bought again as a sliver.
  const sendCostWei = SEND_GAS_UNITS * s.gasPriceWei + s.l1FeeWei;
  if (toFacilitatorWei > 0n && s.keeperWei >= toFacilitatorWei + l.keeperReserveWei / 2n + sendCostWei) return { kind: "send", toFacilitatorWei };

  // When no swap is possible, ETH the keeper already holds still goes out if it is worth a send
  // (at least 10% of the need), keeping half the reserve.
  const minUseful = toFacilitatorWei / MIN_PARTIAL_DIVISOR;
  const sendable = s.keeperWei - l.keeperReserveWei / 2n - sendCostWei;
  const heldSend = sendable < toFacilitatorWei ? sendable : toFacilitatorWei;
  const fallbackSendWei = toFacilitatorWei > 0n && heldSend > 0n && heldSend >= minUseful ? heldSend : null;
  const fallback = (blocked: Blocked): Plan => (fallbackSendWei ? { kind: "send", toFacilitatorWei: fallbackSendWei, blockedBy: blocked } : blocked);

  // A swap's own transactions must be affordable; a send is not held to that (a gas spike shouldn't
  // stop the keeper handing over ETH it already holds).
  const txCostWei = topupGasWei(s);
  if (s.keeperWei < txCostWei) return fallback({ kind: "blocked", reason: "keeper_out_of_gas", detail: { keeper_wei: String(s.keeperWei), needed_wei: String(txCostWei) } });

  // Spare ETH in the keeper pays first; a swap covers the rest. Reaching here means the keeper would
  // end below half its reserve without one, so the shortfall is positive and at least reserve/2; a
  // partial swap is held to the same floor below.
  const shortfallWei = toFacilitatorWei + l.keeperReserveWei + txCostWei - s.keeperWei;

  // startedAt 0 is an uninitialised round: no evidence the sequencer is up.
  if (s.sequencer && (!s.sequencer.up || s.sequencer.sinceS === 0 || Math.floor(nowMs / 1000) - s.sequencer.sinceS < SEQUENCER_GRACE_S))
    return fallback({ kind: "blocked", reason: "sequencer_down", detail: { up: String(s.sequencer.up), since_s: String(s.sequencer.sinceS) } });
  // Outside a wide sanity band the feed is broken, not the market: a wrong high price would widen the
  // slippage ceiling until it guards nothing.
  if (s.priceE8 < PRICE_MIN_E8 || s.priceE8 > PRICE_MAX_E8) return fallback({ kind: "blocked", reason: "price_invalid", detail: { price_e8: String(s.priceE8) } });
  const ageS = Math.floor(nowMs / 1000) - s.priceUpdatedAt;
  if (ageS > l.priceMaxAgeS) return fallback({ kind: "blocked", reason: "price_stale", detail: { age_s: String(ageS), max_s: String(l.priceMaxAgeS) } });

  // Sized to the tightest of three budgets: one top-up, what is left of the 24 h cap, and the float.
  const budgets: [BlockReason, bigint][] = [
    ["exceeds_per_topup_cap", l.maxUsdcPerTopup],
    ["exceeds_daily_cap", l.maxUsdcPerDay > s.spentDayUsdc ? l.maxUsdcPerDay - s.spentDayUsdc : 0n],
    ["float_insufficient", s.keeperUsdc],
  ];
  const [reason, budget] = budgets.reduce((a, b) => (b[1] < a[1] ? b : a));
  const full = ceilingFor(shortfallWei, s.priceE8, l.maxSlippageBps);
  if (full.usdcMax <= budget) return { kind: "swap", toFacilitatorWei, ethOutWei: shortfallWei, ...full, partial: false, fallbackSendWei };

  // Too big for the budget (ETH got dearer, the facilitator drained further than usual, the float
  // or the day's cap is nearly used): swap what fits, keep the keeper's own reserve and gas whole,
  // and send the facilitator the rest. The next tick tops up again; blocking would let it run dry.
  // Rounding: affordUsdc <= budget / (1 + slip) and usdcForWei(affordWei) <= affordUsdc, so the
  // ceiling below never exceeds the budget.
  const affordUsdc = (budget * 10_000n) / BigInt(10_000 + l.maxSlippageBps);
  const affordWei = (affordUsdc * 10n ** 20n) / s.priceE8;
  const ownWei = shortfallWei - toFacilitatorWei; // the keeper's reserve and gas: never cut (negative when it holds spare ETH)
  const toFacilitator = affordWei - ownWei;
  // A partial swap must deliver at least 10% of the need AND buy at least half the reserve, the same
  // floor as a full swap: no approve/swap/reset for a few cents of ETH.
  if (toFacilitatorWei > 0n && affordWei >= l.keeperReserveWei / 2n && toFacilitator >= minUseful) {
    const part = ceilingFor(affordWei, s.priceE8, l.maxSlippageBps);
    if (part.usdcMax > budget) throw new Error(`invariant: partial ceiling ${part.usdcMax} above budget ${budget}`);
    return { kind: "swap", toFacilitatorWei: toFacilitator, ethOutWei: affordWei, ...part, partial: true, fallbackSendWei };
  }
  return fallback({ kind: "blocked", reason, detail: { needed_wei: String(shortfallWei), budget_usdc: String(budget), spent_24h: String(s.spentDayUsdc), float_usdc: String(s.keeperUsdc) } });
}

/** Gas (L2 + L1 data fees) for one top-up's own transactions. */
function topupGasWei(s: Pick<Snapshot, "gasPriceWei" | "l1FeeWei">): bigint {
  return TOPUP_GAS_UNITS * s.gasPriceWei + (TOPUP_TXS * s.l1FeeWei * KEEPER_TX_BYTES) / SETTLE_TX_BYTES;
}

/**
 * How a swap that threw ended, so the 24 h cap counts it right: "not_sent" and "reverted" spent
 * nothing; "unknown" (e.g. a receipt timeout) may have, so it keeps counting at its ceiling.
 */
export class SwapError extends Error {
  constructor(
    readonly outcome: "not_sent" | "reverted" | "unknown",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The pool's quote must fit under the oracle-derived maximum, or the swap is refused. */
export function checkQuote(p: Extract<Plan, { kind: "swap" }>, quoteUsdc: bigint): Plan {
  if (quoteUsdc <= p.usdcMax) return p;
  const blocked: Blocked = { kind: "blocked", reason: "quote_above_oracle", detail: { quote_usdc: String(quoteUsdc), usdc_max: String(p.usdcMax), oracle_usdc: String(p.oracleUsdc) } };
  return p.fallbackSendWei ? { kind: "send", toFacilitatorWei: p.fallbackSendWei, blockedBy: blocked } : blocked;
}

/** Live cost of one settle in USDC atomic: measured gas units at the current gas price, plus the L1 data fee, at Chainlink ETH/USD. */
export function settleCostUsdc(gasPriceWei: bigint, l1FeeWei: bigint, priceE8: bigint): bigint {
  return usdcForWei(SETTLE_GAS_UNITS * gasPriceWei + l1FeeWei, priceE8);
}

export interface Alerts {
  /** Raised once per reason until it clears. */
  raise(reason: string, text: string, detail: Record<string, string>): void;
  clear(reason: string): void;
}

export interface KeeperMetrics {
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  set(name: string, value: number, labels?: Record<string, string>): void;
}

export interface KeeperLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

export type TickResult = { ok: true; plan: Plan["kind"] | "pending"; reason?: BlockReason } | { ok: false; error: string };

const gwei = (wei: bigint) => Number(wei) / 1e9;
const usd = (atomic: bigint) => Number(atomic) / 1e6;

/** Runs plans against the chain. One tick at a time: a tick that finds one in flight does nothing. */
export class Keeper {
  /**
   * Swaps in the last 24 h, for the daily cap. In memory: a restart starts it at zero, so the cap
   * bounds a runaway within a process and the float balance is the hard ceiling across restarts.
   */
  private spends: { at: number; usdc: bigint }[] = [];
  private running: Promise<TickResult> | null = null;
  private stopping = false;
  private failures = 0;
  private pendingTicks = 0;
  last: { at: number; result: TickResult } | null = null;

  constructor(
    private readonly chain: KeeperChain,
    private readonly limits: Limits,
    private readonly d: { metrics: KeeperMetrics; log: KeeperLog; alerts: Alerts; now?: () => number },
  ) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  async tick(): Promise<TickResult | null> {
    if (this.running) return null;
    this.running = this.run().catch((e: Error) => ({ ok: false as const, error: `unexpected: ${e.message}` }));
    try {
      const result = await this.running;
      this.last = { at: this.now(), result };
      this.d.metrics.inc("gas_keeper_ticks_total", { result: result.ok ? "ok" : "error" });
      this.track(result);
      return result;
    } finally {
      this.running = null;
    }
  }

  spentDay(): bigint {
    const since = this.now() - DAY_MS;
    this.spends = this.spends.filter((s) => s.at > since);
    return this.spends.reduce((sum, s) => sum + s.usdc, 0n);
  }

  /**
   * Shutdown: the tick in flight finishes the transaction it is waiting on but starts no new one
   * (no swap, no reset, no send). The next process recovers from chain state.
   */
  requestStop() {
    this.stopping = true;
  }

  /** Resolves once no tick is in flight: shutdown waits on this so a top-up isn't cut off mid-way. */
  async idle(): Promise<void> {
    await this.running?.catch(() => {});
  }

  /** Repeated failures (or a transaction stuck in flight) mean the facilitator isn't being refilled: say so. */
  private track(r: TickResult) {
    const { alerts } = this.d;
    const l = this.limits;
    this.failures = r.ok ? 0 : this.failures + 1;
    if (this.failures >= l.failAlertTicks) alerts.raise("topup_failing", `gas-keeper: ${this.failures} ticks in a row failed`, { last_error: r.ok ? "" : r.error });
    else if (r.ok) alerts.clear("topup_failing");
    this.pendingTicks = r.ok && r.plan === "pending" ? this.pendingTicks + 1 : 0;
    if (this.pendingTicks >= l.failAlertTicks) alerts.raise("tx_stuck", `gas-keeper: a transaction has been pending for ${this.pendingTicks} ticks`, {});
    else if (this.pendingTicks === 0) alerts.clear("tx_stuck");
  }

  private async run(): Promise<TickResult> {
    const { chain, limits: l, d } = this;

    if (this.stopping) return { ok: true, plan: "idle" };

    // In flight before the reads? Checked again after them: a transaction that was pending when the
    // balances were read is caught by one or the other, so plan() never sees a half-landed state.
    let pendingBefore: boolean;
    try {
      pendingBefore = await chain.hasPendingTx();
    } catch (e) {
      d.log.error({ err: e }, "could not read pending nonce");
      return { ok: false, error: `read: ${(e as Error).message}` };
    }

    // Read, and raise the read-only alerts (facilitator below minimum, float low, settle cost)
    // before any gate below can return early: a stuck transaction must not hide a draining facilitator.
    let s: Snapshot;
    let codeAt: Address[];
    try {
      const flags = await Promise.all([chain.hasCode(chain.address), chain.hasCode(l.facilitator)]);
      codeAt = [chain.address, l.facilitator].filter((_, i) => flags[i]);
      const [facilitatorWei, keeperWei, keeperUsdc, price, gasPriceWei, sequencer, l1] = await Promise.all([
        chain.ethBalance(l.facilitator),
        chain.ethBalance(chain.address),
        chain.usdcBalance(),
        chain.ethUsd(),
        chain.gasPriceWei(),
        chain.sequencer(),
        chain.settleL1FeeWei(),
      ]);
      s = { facilitatorWei, keeperWei, keeperUsdc, priceE8: price.priceE8, priceUpdatedAt: price.updatedAt, gasPriceWei, sequencer, l1FeeWei: l1, spentDayUsdc: this.spentDay() };
    } catch (e) {
      d.log.error({ err: e }, "could not read chain state");
      return { ok: false, error: `read: ${(e as Error).message}` };
    }
    this.observe(s);

    // Never plan on balances that a transaction in flight is about to change: that is how one
    // shortfall gets swapped for twice (a receipt timeout, a restart mid top-up).
    try {
      if (pendingBefore || (await chain.hasPendingTx())) {
        d.log.warn({}, "transaction in flight; waiting for it to mine");
        return { ok: true, plan: "pending" };
      }
    } catch (e) {
      d.log.error({ err: e }, "could not read pending nonce");
      return { ok: false, error: `read: ${(e as Error).message}` };
    }

    // A wallet with code (a sweeper delegation on a leaked key) signs nothing at all, not even a reset.
    // Checked every tick, not only at start: a delegation can be added to a leaked key at any time.
    if (codeAt.length) return this.blocked({ kind: "blocked", reason: "wallet_has_code", detail: { addresses: codeAt.join(",") } });

    // An approval left behind (a receipt timeout, a crash between approve and reset) is withdrawn
    // first, unless shutdown has begun: that would be a new transaction.
    if (this.stopping) return { ok: true, plan: "idle" };
    try {
      if ((await chain.routerAllowance()) > 0n) {
        const tx = await chain.resetAllowance();
        d.metrics.inc("gas_keeper_allowance_resets_total", { when: "leftover" });
        d.log.warn({ tx }, "reset a leftover router allowance");
        s = { ...s, keeperWei: await chain.ethBalance(chain.address) }; // it paid gas
      }
    } catch (e) {
      d.log.error({ err: e }, "could not reset leftover router allowance");
      return { ok: false, error: `allowance: ${(e as Error).message}` };
    }

    let p: Plan = plan(s, l, this.now());
    let quoteError: string | null = null;
    if (p.kind === "swap") {
      const swap = p;
      try {
        p = checkQuote(swap, await chain.quoteUsdcForEth(swap.ethOutWei));
      } catch (e) {
        d.log.error({ err: e }, "quote failed");
        quoteError = `quote: ${(e as Error).message}`;
        // The quoter is down: still hand over ETH the keeper already holds.
        if (!swap.fallbackSendWei) return { ok: false, error: quoteError };
        p = { kind: "send", toFacilitatorWei: swap.fallbackSendWei };
      }
    }

    if (p.kind === "blocked") return this.blocked(p);
    // A send standing in for a refused swap keeps that reason alerted (no flapping); others clear.
    const still = p.kind === "send" ? p.blockedBy?.reason : undefined;
    for (const r of BLOCK_REASONS) if (r !== still) d.alerts.clear(r);
    if (p.kind === "send" && p.blockedBy) {
      d.metrics.inc("gas_keeper_blocked_total", { reason: p.blockedBy.reason });
      d.log.warn({ reason: p.blockedBy.reason, ...p.blockedBy.detail, send_wei: String(p.toFacilitatorWei) }, "swap blocked; sending ETH the keeper holds instead");
      d.alerts.raise(p.blockedBy.reason, `gas-keeper: top-up swap blocked (${p.blockedBy.reason}); sent held ETH instead`, p.blockedBy.detail);
    }
    if (p.kind === "idle") return { ok: true, plan: "idle" };

    let spend: { at: number; usdc: bigint } | null = null;
    try {
      if (p.kind === "swap") {
        // Every transaction is its own step, and none starts once shutdown has begun.
        if (this.stopping) return { ok: true, plan: "idle" };
        await chain.approveRouter(p.usdcMax);
        if (this.stopping) return { ok: false, error: "stopped after approve; the next start withdraws the allowance" };
        if (p.partial) d.metrics.inc("gas_keeper_partial_topups_total");
        // Counted at its ceiling before broadcasting: if the outcome stays unknown (a receipt
        // timeout), the cap assumes the worst. Set to the real amount once it is known.
        spend = { at: this.now(), usdc: p.usdcMax };
        this.spends.push(spend);
        const { tx, usdcSpent } = await chain.swapUsdcForEth(p.ethOutWei, p.usdcMax);
        spend.usdc = usdcSpent;
        d.metrics.inc("gas_keeper_usdc_spent_total", undefined, usd(usdcSpent));
        d.log.info({ tx, eth_out_wei: String(p.ethOutWei), usdc_spent: String(usdcSpent), usdc_max: String(p.usdcMax), oracle_usdc: String(p.oracleUsdc) }, "swapped USDC for ETH");
        if (this.stopping) return { ok: false, error: "stopped after swap; the next start sends the ETH" };
        // Best effort: a failed reset must not hide a mined swap. The next tick retries it.
        try {
          if ((await chain.routerAllowance()) > 0n) {
            await chain.resetAllowance();
            d.metrics.inc("gas_keeper_allowance_resets_total", { when: "after_swap" });
          }
        } catch (e) {
          d.log.warn({ err: e }, "allowance reset after swap failed; retrying next tick");
        }
      }
      if (p.toFacilitatorWei > 0n) {
        if (this.stopping) return { ok: false, error: "stopped before send; the next start sends the ETH" };
        const tx = await chain.sendEth(l.facilitator, p.toFacilitatorWei);
        d.metrics.inc("gas_keeper_eth_sent_gwei_total", undefined, gwei(p.toFacilitatorWei));
        d.log.info({ tx, to: l.facilitator, value_wei: String(p.toFacilitatorWei) }, "topped up facilitator");
      }
      d.metrics.inc("gas_keeper_topups_total", { result: "ok", kind: p.kind });
      // A send that stood in for a failed quote still counts as a failed tick, so topup_failing fires if it persists.
      return quoteError ? { ok: false, error: `${quoteError} (sent held ETH instead)` } : { ok: true, plan: p.kind };
    } catch (e) {
      if (spend && e instanceof SwapError && e.outcome !== "unknown") spend.usdc = 0n; // known: nothing spent
      // Safe to retry: the next tick waits for anything still in flight, then plans on fresh balances,
      // so ETH a mined swap delivered is sent, not swapped for again.
      d.metrics.inc("gas_keeper_topups_total", { result: "error", kind: p.kind });
      d.log.error({ err: e, plan: p.kind }, "top-up failed");
      return { ok: false, error: `${p.kind}: ${(e as Error).message}` };
    }
  }

  private blocked(p: Blocked): TickResult {
    const { d } = this;
    for (const r of BLOCK_REASONS) if (r !== p.reason) d.alerts.clear(r);
    d.metrics.inc("gas_keeper_blocked_total", { reason: p.reason });
    d.log.error({ reason: p.reason, ...p.detail }, "top-up needed but blocked");
    d.alerts.raise(p.reason, `gas-keeper: top-up blocked (${p.reason})`, p.detail);
    return { ok: true, plan: "blocked", reason: p.reason };
  }

  /** Balances, price and the live cost of one settle against the allowance built into prices. */
  private observe(s: Snapshot) {
    const { metrics: m, alerts, log } = this.d;
    const l = this.limits;
    m.set("gas_keeper_facilitator_balance_gwei", gwei(s.facilitatorWei));
    m.set("gas_keeper_keeper_balance_gwei", gwei(s.keeperWei));
    m.set("gas_keeper_float_usdc", usd(s.keeperUsdc));
    m.set("gas_keeper_eth_usd", Number(s.priceE8) / 1e8);
    m.set("gas_keeper_gas_price_gwei", gwei(s.gasPriceWei));
    m.set("gas_keeper_usdc_spent_24h", usd(s.spentDayUsdc));

    const cost = settleCostUsdc(s.gasPriceWei, s.l1FeeWei, s.priceE8);
    m.set("gas_keeper_settle_cost_usd", usd(cost));
    const over = cost > GAS_ALLOWANCE_NET_USDC;
    m.set("gas_keeper_settle_cost_over_allowance", over ? 1 : 0);
    if (over) {
      const detail = { settle_cost_usd: String(usd(cost)), allowance_net_usd: String(usd(GAS_ALLOWANCE_NET_USDC)), gas_price_gwei: String(gwei(s.gasPriceWei)) };
      log.warn(detail, "one settle now costs more gas than the price allowance (net of VAT)");
      alerts.raise("settle_cost_over_allowance", "gas-keeper: one x402 settle costs more gas than the price allowance (net of VAT)", detail);
    } else alerts.clear("settle_cost_over_allowance");

    if (s.facilitatorWei < l.facilitatorMinWei)
      alerts.raise("facilitator_below_min", "gas-keeper: the facilitator is below its minimum gas balance and has stopped settling", { facilitator_wei: String(s.facilitatorWei) });
    else alerts.clear("facilitator_below_min");

    const topupGas = topupGasWei(s);
    if (s.keeperWei < topupGas) alerts.raise("keeper_gas_low", "gas-keeper: the keeper can't pay for a top-up's own transactions; send it a little ETH", { keeper_wei: String(s.keeperWei), needed_wei: String(topupGas) });
    else alerts.clear("keeper_gas_low");

    if (s.keeperUsdc < l.floatLowUsdc) alerts.raise("float_low", "gas-keeper: float wallet is low on USDC, move more in from the treasury", { float_usdc: String(usd(s.keeperUsdc)) });
    else alerts.clear("float_low");
  }
}

/**
 * Alerts to an optional webhook. A reason is active while its condition holds (shown on /readyz and
 * as gas_keeper_alert_active); its webhook is sent once per activation, retried on each raise until
 * delivered.
 */
export class WebhookAlerts implements Alerts {
  private active = new Set<string>();
  private delivered = new Set<string>();
  private sending = new Set<string>();
  /** Bumped on each activation, so a POST for an earlier activation can't mark a newer one delivered. */
  private generation = new Map<string, number>();
  constructor(private readonly o: { url?: string; network: string; metrics: KeeperMetrics; log: KeeperLog; fetch?: typeof fetch }) {}

  raise(reason: string, text: string, detail: Record<string, string>) {
    if (!this.active.has(reason)) {
      this.active.add(reason);
      this.generation.set(reason, (this.generation.get(reason) ?? 0) + 1);
      this.o.metrics.set("gas_keeper_alert_active", 1, { reason });
      this.o.log.error({ reason, ...detail }, text);
    }
    if (!this.o.url || this.delivered.has(reason) || this.sending.has(reason)) return;
    this.sending.add(reason);
    const gen = this.generation.get(reason);
    let sent: Promise<Response>;
    try {
      sent = (this.o.fetch ?? fetch)(this.o.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${text} on ${this.o.network}`, reason, detail }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      sent = Promise.reject(e);
    }
    void sent
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        if (this.active.has(reason) && this.generation.get(reason) === gen) this.delivered.add(reason);
      })
      .catch((e) => {
        this.o.metrics.inc("gas_keeper_alert_webhook_failed_total", { reason });
        this.o.log.warn({ err: e, reason }, "alert webhook failed; retrying on the next raise");
      })
      .finally(() => this.sending.delete(reason));
  }

  clear(reason: string) {
    this.delivered.delete(reason);
    if (!this.active.delete(reason)) return;
    this.o.metrics.set("gas_keeper_alert_active", 0, { reason });
  }

  activeReasons(): string[] {
    return [...this.active];
  }
}
