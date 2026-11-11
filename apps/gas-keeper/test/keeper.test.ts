import { Metrics } from "@mx/shared";
import { parseEther, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  checkQuote,
  DAY_MS,
  GAS_ALLOWANCE_NET_USDC,
  Keeper,
  plan,
  SEQUENCER_GRACE_S,
  settleCostUsdc,
  SwapError,
  TOPUP_GAS_UNITS,
  usdcForWei,
  WebhookAlerts,
  type KeeperChain,
  type Limits,
  type Snapshot,
} from "../src/keeper";
import { startLoop } from "../src/runner";

const FACILITATOR = "0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5" as Address;
const KEEPER = "0x00000000000000000000000000000000000000Ee" as Address;
const NOW = 1_800_000_000_000;
const PRICE = 2_000_00000000n; // $2,000.00000000
const GAS = 6_000_000n; // 0.006 gwei, Base mainnet on 2026-11-11
const TX_COST = TOPUP_GAS_UNITS * GAS;
const usdc = (d: number) => BigInt(Math.round(d * 1e6));
const ceil = (oracle: bigint, bps = 100) => (oracle * BigInt(10_000 + bps)) / 10_000n;

const limits: Limits = {
  facilitator: FACILITATOR,
  facilitatorMinWei: parseEther("0.001"),
  triggerWei: parseEther("0.003"),
  targetWei: parseEther("0.01"),
  keeperReserveWei: parseEther("0.001"),
  maxUsdcPerTopup: usdc(50),
  maxUsdcPerDay: usdc(100),
  maxSlippageBps: 100,
  priceMaxAgeS: 1800,
  floatLowUsdc: usdc(10),
  failAlertTicks: 3,
};

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  facilitatorWei: parseEther("0.002"),
  keeperWei: parseEther("0.001"),
  keeperUsdc: usdc(40),
  priceE8: PRICE,
  priceUpdatedAt: NOW / 1000 - 60,
  gasPriceWei: GAS,
  sequencer: { up: true, sinceS: NOW / 1000 - 86_400 },
  l1FeeWei: 0n,
  spentDayUsdc: 0n,
  ...over,
});

/** The swap a facilitator at 0.002 needs: 0.008 to target, plus the keeper's own gas for this top-up. */
const SWAP_ETH = parseEther("0.008") + TX_COST;
const SWAP_ORACLE = usdcForWei(SWAP_ETH, PRICE);
const SWAP_MAX = ceil(SWAP_ORACLE);

describe("usdcForWei / settleCostUsdc / allowance", () => {
  it("prices ETH in USDC atomic, rounding up so the ceiling is never short", () => {
    expect(usdcForWei(parseEther("1"), PRICE)).toBe(usdc(2000));
    expect(usdcForWei(parseEther("0.008"), PRICE)).toBe(usdc(16));
    expect(usdcForWei(1n, PRICE)).toBe(1n);
  });

  it("costs one settle from measured gas units plus the L1 fee", () => {
    expect(settleCostUsdc(GAS, 0n, PRICE)).toBe(1_030n); // 85,752 x 0.006 gwei x $2,000 = $0.001029, rounded up
    expect(settleCostUsdc(GAS, 19_142_431_597n, PRICE)).toBe(1_068n); // + the L1 upper bound read on 2026-11-11: 533,654 gwei, $0.0010673
  });

  it("measures cost against the allowance net of VAT: $0.002 incl. 20% VAT leaves $0.001666", () => {
    expect(GAS_ALLOWANCE_NET_USDC).toBe(1_666n);
  });
});

describe("plan", () => {
  it("does nothing while the facilitator is above the trigger and the keeper has its reserve", () => {
    expect(plan(snap({ facilitatorWei: parseEther("0.003") }), limits, NOW)).toEqual({ kind: "idle" });
  });

  it("swaps the shortfall plus its own gas, so the keeper ends with its reserve; ceiling = oracle + slippage", () => {
    expect(plan(snap(), limits, NOW)).toEqual({ kind: "swap", toFacilitatorWei: parseEther("0.008"), ethOutWei: SWAP_ETH, usdcMax: SWAP_MAX, oracleUsdc: SWAP_ORACLE, partial: false, fallbackSendWei: null });
    expect(SWAP_MAX).toBe(16_167_272n); // $16.0072 at the oracle, +1%
  });

  it("also restores the keeper's own reserve in the same swap", () => {
    expect(plan(snap({ keeperWei: parseEther("0.0004") }), limits, NOW)).toMatchObject({ kind: "swap", toFacilitatorWei: parseEther("0.008"), ethOutWei: parseEther("0.0086") + TX_COST });
  });

  it("restores a low keeper reserve even when the facilitator is fine", () => {
    expect(plan(snap({ facilitatorWei: parseEther("0.02"), keeperWei: parseEther("0.0004") }), limits, NOW)).toMatchObject({
      kind: "swap",
      toFacilitatorWei: 0n,
      ethOutWei: parseEther("0.0006") + TX_COST,
    });
  });

  it("sends ETH the keeper already holds instead of swapping (recovery after a failed send)", () => {
    expect(plan(snap({ keeperWei: parseEther("0.0095") }), limits, NOW)).toEqual({ kind: "send", toFacilitatorWei: parseEther("0.008") });
  });

  it("recovery never buys back the swap's own gas as a sliver: the real post-swap balance just sends", () => {
    // After a mined swap whose send failed: reserve + this top-up's gas budget - gas actually used + the ETH.
    const afterSwap = parseEther("0.001") + TX_COST - 450_000n * GAS + parseEther("0.008");
    expect(plan(snap({ keeperWei: afterSwap }), limits, NOW)).toEqual({ kind: "send", toFacilitatorWei: parseEther("0.008") });
    // Even if the swap used its whole gas budget and then some (an L1 fee spike), still a send.
    expect(plan(snap({ keeperWei: parseEther("0.008") + parseEther("0.0006") }), limits, NOW)).toMatchObject({ kind: "send" });
    // A swap only happens when the keeper would end below half its reserve, so it is never dust.
    const p = plan(snap({ keeperWei: parseEther("0.008") + parseEther("0.0004") }), limits, NOW);
    expect(p).toMatchObject({ kind: "swap" });
    expect((p as { ethOutWei: bigint }).ethOutWei).toBeGreaterThanOrEqual(limits.keeperReserveWei / 2n);
  });

  it("swaps only the part spare keeper ETH does not cover", () => {
    expect(plan(snap({ keeperWei: parseEther("0.005") }), limits, NOW)).toMatchObject({ kind: "swap", ethOutWei: parseEther("0.004") + TX_COST });
    expect(plan(snap({ keeperWei: parseEther("0.0084") }), limits, NOW)).toMatchObject({ kind: "swap", ethOutWei: parseEther("0.0006") + TX_COST });
  });

  it("budgets the keeper's own L1 data fees too (four transactions, at the swap's ~700 bytes)", () => {
    const l1 = 20_000_000_000n; // priced for a 410-byte settle
    const keeperL1 = (4n * l1 * 700n) / 410n;
    expect(plan(snap({ l1FeeWei: l1 }), limits, NOW)).toMatchObject({ ethOutWei: SWAP_ETH + keeperL1 });
    expect(plan(snap({ l1FeeWei: l1, keeperWei: TX_COST + keeperL1 - 1n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "keeper_out_of_gas" });
  });

  it("is blocked when the keeper cannot pay for its own transactions", () => {
    expect(plan(snap({ keeperWei: TX_COST - 1n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "keeper_out_of_gas" });
  });

  it("a gas spike that rules out a swap still lets held ETH go out", () => {
    const spike = 2_000_000_000n; // 2 gwei: a top-up's own gas is 0.0012 ETH
    const keeperWei = parseEther("0.0007");
    // Facilitator at 0.0028 under a 0.0035 target: it needs 0.0007, and the keeper can spare ~0.000158 (23%).
    const p = plan(snap({ gasPriceWei: spike, keeperWei, facilitatorWei: parseEther("0.0028") }), { ...limits, targetWei: parseEther("0.0035") }, NOW);
    expect(p).toMatchObject({ kind: "send", toFacilitatorWei: keeperWei - limits.keeperReserveWei / 2n - 21_000n * spike, blockedBy: { reason: "keeper_out_of_gas" } });
  });

  it("refuses a price outside the sanity band ($100 to $100,000): a broken feed, not a market", () => {
    expect(plan(snap({ priceE8: 99n * 10n ** 8n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "price_invalid" });
    expect(plan(snap({ priceE8: 100_001n * 10n ** 8n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "price_invalid" });
    expect(plan(snap({ priceE8: 100n * 10n ** 8n }), limits, NOW)).toMatchObject({ kind: "swap" });
  });

  it("sends held ETH when the sequencer is down or in grace, or the price is stale or out of band", () => {
    const k = parseEther("0.005");
    const sendable = k - limits.keeperReserveWei / 2n - 21_000n * GAS;
    const cases: [Partial<Snapshot>, string][] = [
      [{ sequencer: { up: false, sinceS: NOW / 1000 - 86_400 } }, "sequencer_down"],
      [{ sequencer: { up: true, sinceS: NOW / 1000 - 60 } }, "sequencer_down"],
      [{ priceE8: 50n * 10n ** 8n }, "price_invalid"],
      [{ priceUpdatedAt: NOW / 1000 - 7_200 }, "price_stale"],
    ];
    for (const [over, reason] of cases) {
      expect(plan(snap({ keeperWei: k, ...over }), limits, NOW)).toEqual({ kind: "send", toFacilitatorWei: sendable, blockedBy: expect.objectContaining({ reason }) });
    }
  });

  it("refuses a stale or invalid price", () => {
    expect(plan(snap({ priceUpdatedAt: NOW / 1000 - 1801 }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "price_stale" });
    expect(plan(snap({ priceE8: 0n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "price_invalid" });
    expect(plan(snap({ priceE8: -1n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "price_invalid" });
  });

  it("won't trade while the sequencer is down or inside the grace period after it returns", () => {
    expect(plan(snap({ sequencer: { up: false, sinceS: NOW / 1000 - 86_400 } }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "sequencer_down" });
    expect(plan(snap({ sequencer: { up: true, sinceS: NOW / 1000 - SEQUENCER_GRACE_S + 1 } }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "sequencer_down" });
    expect(plan(snap({ sequencer: { up: true, sinceS: NOW / 1000 - SEQUENCER_GRACE_S } }), limits, NOW)).toMatchObject({ kind: "swap" });
    expect(plan(snap({ sequencer: null }), limits, NOW)).toMatchObject({ kind: "swap" }); // no feed on this network
    expect(plan(snap({ sequencer: { up: true, sinceS: 0 } }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "sequencer_down" }); // uninitialised round
  });

  it("shrinks a top-up that won't fit the per-top-up cap, keeping the keeper's reserve whole", () => {
    const cap = usdc(10);
    const p = plan(snap(), { ...limits, maxUsdcPerTopup: cap }, NOW);
    expect(p).toMatchObject({ kind: "swap", partial: true });
    if (p.kind !== "swap") throw new Error("unreachable");
    expect(p.usdcMax).toBeLessThanOrEqual(cap);
    expect(p.usdcMax).toBeGreaterThan(cap - usdc(0.01)); // uses (nearly) all of it
    // Everything the swap buys beyond the keeper's own gas goes to the facilitator.
    expect(p.ethOutWei - p.toFacilitatorWei).toBe(TX_COST);
    expect(p.toFacilitatorWei).toBeGreaterThan(parseEther("0.004"));
    expect(p.toFacilitatorWei).toBeLessThan(parseEther("0.008"));
    // Exactly at the cap: a full top-up, not partial.
    expect(plan(snap(), { ...limits, maxUsdcPerTopup: SWAP_MAX }, NOW)).toMatchObject({ kind: "swap", partial: false });
    // The float and the day's remaining headroom size a top-up the same way, reporting which bound it.
    const byFloat = plan(snap({ keeperUsdc: usdc(10) }), limits, NOW);
    expect(byFloat).toMatchObject({ kind: "swap", partial: true });
    expect((byFloat as { usdcMax: bigint }).usdcMax).toBeLessThanOrEqual(usdc(10));
    const byDay = plan(snap({ spentDayUsdc: usdc(92) }), limits, NOW);
    expect(byDay).toMatchObject({ kind: "swap", partial: true });
    expect((byDay as { usdcMax: bigint }).usdcMax).toBeLessThanOrEqual(usdc(8));
    expect(plan(snap({ keeperWei: TX_COST, keeperUsdc: 1n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "float_insufficient" });
    expect(plan(snap({ keeperWei: TX_COST, spentDayUsdc: usdc(100) }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "exceeds_daily_cap" });
    // No dust: a budget that buys under 10% of the need is blocked, not spent on fees.
    expect(plan(snap({ spentDayUsdc: usdc(98.5) }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "exceeds_daily_cap" }); // ~$1.49: 0.00074 ETH < 0.0008
    expect(plan(snap({ spentDayUsdc: usdc(98.3) }), limits, NOW)).toMatchObject({ kind: "swap", partial: true }); // ~$1.68: 0.00084 ETH
    // A cap too small to buy even the keeper's own gas is blocked.
    expect(plan(snap({ keeperWei: TX_COST }), { ...limits, maxUsdcPerTopup: 1n }, NOW)).toMatchObject({ kind: "blocked", reason: "exceeds_per_topup_cap" });
  });

  it("with spare keeper ETH and nothing worth swapping, it sends what it holds instead of buying dust", () => {
    const k = parseEther("0.005"); // the operator topped the keeper up by hand
    const sendable = k - limits.keeperReserveWei / 2n - 21_000n * GAS;
    for (const float of [0n, usdc(0.01), usdc(0.5)]) {
      expect(plan(snap({ keeperWei: k, keeperUsdc: float }), limits, NOW)).toMatchObject({ kind: "send", toFacilitatorWei: sendable, blockedBy: { reason: "float_insufficient" } });
    }
    expect(plan(snap({ keeperWei: k, spentDayUsdc: usdc(100) }), limits, NOW)).toMatchObject({ kind: "send", toFacilitatorWei: sendable, blockedBy: { reason: "exceeds_daily_cap" } });
    // Less than 10% of the need to send, and nothing to swap with: blocked with the real reason, no 0-wei swap.
    expect(plan(snap({ keeperWei: parseEther("0.0011"), keeperUsdc: 0n }), limits, NOW)).toMatchObject({ kind: "blocked", reason: "float_insufficient" });
  });

  it("every swap buys at least half the reserve, and partial ceilings fit their budget (randomised, incl. spare keeper ETH)", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed % n);
    let swaps = 0;
    for (let i = 0; i < 3_000; i++) {
      const priceE8 = BigInt(500 + rnd(9_500)) * 10n ** 8n;
      const keeperUsdc = BigInt(rnd(60_000_000));
      const spentDayUsdc = BigInt(rnd(100_000_000));
      const facilitatorWei = BigInt(rnd(2_999_999)) * 10n ** 9n;
      const keeperWei = TX_COST + BigInt(rnd(12_000_000)) * 10n ** 9n;
      const p = plan(snap({ priceE8, keeperUsdc, spentDayUsdc, facilitatorWei, keeperWei }), limits, NOW);
      const need = limits.targetWei - facilitatorWei;
      if (p.kind === "swap") {
        swaps++;
        expect(p.ethOutWei).toBeGreaterThanOrEqual(limits.keeperReserveWei / 2n);
        expect(p.usdcMax).toBeLessThanOrEqual([limits.maxUsdcPerTopup, limits.maxUsdcPerDay - spentDayUsdc, keeperUsdc].reduce((a, b) => (b < a ? b : a)));
        expect(p.toFacilitatorWei).toBeGreaterThanOrEqual(need / 10n);
        expect(p.toFacilitatorWei).toBeLessThanOrEqual(need);
      }
      if (p.kind === "send") {
        expect(p.toFacilitatorWei).toBeGreaterThanOrEqual(need / 10n);
        expect(p.toFacilitatorWei).toBeLessThanOrEqual(need);
        expect(keeperWei - p.toFacilitatorWei).toBeGreaterThanOrEqual(limits.keeperReserveWei / 2n); // it can still pay its way
      }
    }
    expect(swaps).toBeGreaterThan(100); // the sample really exercises swaps
  });

  it("a partial ceiling never exceeds its budget, and the keeper's share is never cut (randomised)", () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed % n);
    for (let i = 0; i < 2_000; i++) {
      const priceE8 = BigInt(500 + rnd(9_500)) * 10n ** 8n + BigInt(rnd(10 ** 8));
      const cap = BigInt(1 + rnd(60_000_000));
      const bps = 50 + rnd(450);
      const facilitatorWei = BigInt(rnd(2_999_999)) * 10n ** 9n;
      const keeperWei = TX_COST + BigInt(rnd(2_000_000)) * 10n ** 9n;
      const p = plan(snap({ priceE8, facilitatorWei, keeperWei }), { ...limits, maxUsdcPerTopup: cap, maxSlippageBps: bps }, NOW);
      if (p.kind !== "swap") continue;
      expect(p.usdcMax).toBeLessThanOrEqual(cap);
      expect(p.toFacilitatorWei).toBeGreaterThanOrEqual((limits.targetWei - facilitatorWei) / 10n);
      expect(p.toFacilitatorWei).toBeLessThanOrEqual(limits.targetWei - facilitatorWei);
      // The keeper's share (reserve and gas not already held) is bought in full, never cut.
      const own = limits.keeperReserveWei + TX_COST - keeperWei;
      if (own >= 0n) expect(p.ethOutWei - p.toFacilitatorWei).toBe(own);
      else expect(p.ethOutWei).toBe(p.toFacilitatorWei + own); // spare keeper ETH reduces the swap
    }
  });

  it("a full top-up needs its whole ceiling inside the day's headroom and the float, else it is sized down", () => {
    expect(plan(snap({ spentDayUsdc: usdc(100) - SWAP_MAX }), limits, NOW)).toMatchObject({ kind: "swap", partial: false });
    expect(plan(snap({ spentDayUsdc: usdc(100) - SWAP_MAX + 1n }), limits, NOW)).toMatchObject({ kind: "swap", partial: true });
    expect(plan(snap({ keeperUsdc: SWAP_MAX }), limits, NOW)).toMatchObject({ kind: "swap", partial: false });
    expect(plan(snap({ keeperUsdc: SWAP_MAX - 1n }), limits, NOW)).toMatchObject({ kind: "swap", partial: true });
  });

  it("a send needs no price or sequencer, so neither blocks delivering ETH already held", () => {
    expect(plan(snap({ keeperWei: parseEther("0.0095"), priceUpdatedAt: 0, sequencer: { up: false, sinceS: 0 } }), limits, NOW)).toMatchObject({ kind: "send" });
  });
});

describe("checkQuote", () => {
  const p = plan(snap(), limits, NOW) as Extract<ReturnType<typeof plan>, { kind: "swap" }>;
  it("accepts a quote at or under the ceiling and refuses one above it", () => {
    expect(checkQuote(p, SWAP_MAX)).toBe(p);
    expect(checkQuote(p, usdc(15))).toBe(p); // a cheaper pool is fine
    expect(checkQuote(p, SWAP_MAX + 1n)).toMatchObject({ kind: "blocked", reason: "quote_above_oracle" });
  });
});

/**
 * A chain with a mempool: a transaction can be broadcast and stay pending (the keeper's receipt
 * wait times out) until mine() lands it, exactly as on a congested network or across a restart.
 */
class FakeChain implements KeeperChain {
  readonly address = KEEPER;
  balances = new Map<Address, bigint>([
    [FACILITATOR, parseEther("0.002")],
    [KEEPER, parseEther("0.001")],
  ]);
  usdcHeld = usdc(40);
  allowance = 0n;
  outflows: { at: number; usdc: bigint }[] = [];
  price = { priceE8: PRICE, updatedAt: NOW / 1000 - 60 };
  gasPrice = GAS;
  seq: { up: boolean; sinceS: number } | null = { up: true, sinceS: NOW / 1000 - 86_400 };
  quote: (ethOut: bigint) => bigint = (ethOut) => usdcForWei(ethOut, PRICE) + 5_000n; // pool 0.5 cents worse than oracle
  withCode = new Set<Address>();
  mempool: (() => void)[] = [];
  /** "timeout": the swap is broadcast but its receipt wait times out (it mines later, on mine()). */
  swapMode: "ok" | "timeout" | "revert" | "not_sent" = "ok";
  onSwap?: () => void;
  failSend = false;
  failRead = false;
  failReset = false;
  calls: string[] = [];
  swapGate?: Promise<void>;
  clock = () => NOW;
  /** Every keeper transaction costs gas, as on a real chain: 150k gas each (4 of them = TOPUP_GAS_UNITS). */
  private payGas() {
    this.balances.set(KEEPER, this.balances.get(KEEPER)! - 150_000n * this.gasPrice);
  }

  mine() {
    for (const tx of this.mempool.splice(0)) tx();
  }
  async hasPendingTx() {
    return this.mempool.length > 0;
  }
  async ethBalance(who: Address) {
    if (this.failRead) throw new Error("rpc down");
    return this.balances.get(who) ?? 0n;
  }
  async hasCode(who: Address) {
    return this.withCode.has(who);
  }
  async usdcBalance() {
    return this.usdcHeld;
  }
  async ethUsd() {
    return this.price;
  }
  async sequencer() {
    return this.seq;
  }
  async gasPriceWei() {
    return this.gasPrice;
  }
  async settleL1FeeWei() {
    return 0n;
  }
  onQuote?: () => void;
  onReset?: () => void;
  async quoteUsdcForEth(ethOut: bigint) {
    this.onQuote?.();
    return this.quote(ethOut);
  }
  async routerAllowance() {
    return this.allowance;
  }
  async resetAllowance() {
    this.calls.push("reset");
    this.onReset?.();
    if (this.failReset) throw new Error("reset reverted");
    this.payGas();
    this.allowance = 0n;
    return "0xreset" as Hex;
  }
  onApprove?: () => void;
  async approveRouter(usdcMax: bigint) {
    this.calls.push(`approve ${usdcMax}`);
    this.payGas();
    this.allowance = usdcMax;
    this.onApprove?.();
    return "0xapprove" as Hex;
  }
  async swapUsdcForEth(ethOut: bigint, usdcMax: bigint) {
    this.calls.push(`swap ${ethOut} max ${usdcMax}`);
    await this.swapGate;
    this.onSwap?.();
    if (this.swapMode === "not_sent") throw new SwapError("not_sent", "swap (before broadcast): execution reverted");
    this.payGas();
    if (this.swapMode === "revert") throw new SwapError("reverted", "swap reverted: Too much requested");
    const spent = this.quote(ethOut);
    const land = () => {
      this.usdcHeld -= spent;
      this.allowance -= spent;
      this.outflows.push({ at: this.clock(), usdc: spent });
      this.balances.set(KEEPER, this.balances.get(KEEPER)! + ethOut);
    };
    if (this.swapMode === "timeout") {
      this.mempool.push(land);
      throw new SwapError("unknown", "Timed out while waiting for transaction receipt");
    }
    land();
    return { tx: "0xswap" as Hex, usdcSpent: spent };
  }
  async sendEth(to: Address, value: bigint) {
    this.calls.push(`send ${to} ${value}`);
    if (this.failSend) throw new Error("nonce too low");
    this.payGas();
    this.balances.set(KEEPER, this.balances.get(KEEPER)! - value);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + value);
    return "0xsend" as Hex;
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function setup(over: Partial<Limits> = {}, webhook?: string, fetchImpl?: typeof fetch) {
  const chain = new FakeChain();
  const metrics = new Metrics();
  const posted: { reason: string; text: string }[] = [];
  const f =
    fetchImpl ??
    (vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(JSON.parse(String(init!.body)));
      return new Response("ok");
    }) as unknown as typeof fetch);
  const alerts = new WebhookAlerts({ url: webhook, network: "eip155:8453", metrics, log: silent, fetch: f });
  let now = NOW;
  chain.clock = () => now;
  const keeper = new Keeper(chain, { ...limits, ...over }, { metrics, log: silent, alerts, now: () => now });
  return { chain, metrics, alerts, keeper, posted, advance: (ms: number) => (now += ms), at: () => now };
}

describe("Keeper.tick", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("swaps, resets the leftover allowance, then refills the facilitator to target", async () => {
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "swap" });
    expect(t.chain.calls).toEqual([`approve ${SWAP_MAX}`, `swap ${SWAP_ETH} max ${SWAP_MAX}`, "reset", `send ${FACILITATOR} ${parseEther("0.008")}`]);
    expect(t.chain.balances.get(FACILITATOR)).toBe(parseEther("0.01"));
    expect(t.chain.balances.get(KEEPER)).toBe(parseEther("0.001")); // the swap bought its own gas: reserve intact
    expect(t.chain.allowance).toBe(0n);
    expect(t.metrics.get("gas_keeper_usdc_spent_total")).toBeCloseTo(Number(SWAP_ORACLE + 5_000n) / 1e6, 6);
    expect(t.metrics.get("gas_keeper_topups_total", { result: "ok", kind: "swap" })).toBe(1);
  });

  it("is idle on the next tick: the facilitator is at target", async () => {
    await t.keeper.tick();
    t.chain.calls = [];
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(t.chain.calls).toEqual([]);
  });

  it("never swaps twice for one shortfall when a swap's receipt times out (it mines later)", async () => {
    t.chain.swapMode = "timeout";
    expect(await t.keeper.tick()).toMatchObject({ ok: false, error: expect.stringMatching(/^swap: Timed out/) });
    expect(t.keeper.spentDay()).toBe(SWAP_MAX); // outcome unknown: counted at its ceiling
    t.chain.swapMode = "ok";
    // Still in flight: the balances it read are stale, so it must not plan on them.
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "pending" });
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "pending" });
    t.chain.mine();
    t.chain.calls = [];
    // Mined: the ETH is in the keeper, the allowance it left is withdrawn, the ETH is sent. No second swap.
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "send" });
    expect(t.chain.calls).toEqual(["reset", `send ${FACILITATOR} ${parseEther("0.008")}`]);
    expect(t.chain.outflows).toHaveLength(1);
    expect(t.chain.balances.get(FACILITATOR)).toBe(parseEther("0.01"));
  });

  it("recovers a half-done top-up: after a failed send, the next tick sends without swapping again", async () => {
    t.chain.failSend = true;
    expect(await t.keeper.tick()).toMatchObject({ ok: false, error: expect.stringMatching(/^swap: nonce too low/) });
    t.chain.failSend = false;
    t.chain.calls = [];
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "send" });
    expect(t.chain.calls).toEqual([`send ${FACILITATOR} ${parseEther("0.008")}`]);
    expect(t.chain.outflows).toHaveLength(1);
  });

  it("a failed allowance reset after a mined swap doesn't hide the swap; the next tick withdraws it", async () => {
    t.chain.failReset = true;
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "swap" }); // swap and send both done
    expect(t.chain.allowance).toBeGreaterThan(0n);
    t.chain.failReset = false;
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(t.chain.allowance).toBe(0n);
    expect(t.metrics.get("gas_keeper_allowance_resets_total", { when: "leftover" })).toBe(1);
  });

  it("enforces the 24 h cap across top-ups, and frees it a day later", async () => {
    t = setup({ maxUsdcPerTopup: usdc(20), maxUsdcPerDay: usdc(20) });
    expect(await t.keeper.tick()).toMatchObject({ plan: "swap" });
    t.chain.balances.set(FACILITATOR, parseEther("0.002")); // drained again
    expect(await t.keeper.tick()).toMatchObject({ plan: "swap" }); // sized down to the ~$4 left today
    t.chain.balances.set(FACILITATOR, parseEther("0.002"));
    expect(await t.keeper.tick()).toMatchObject({ plan: "blocked", reason: "exceeds_daily_cap" }); // nothing meaningful left
    t.advance(DAY_MS + 1);
    t.chain.price = { priceE8: PRICE, updatedAt: t.at() / 1000 - 60 };
    t.chain.seq = { up: true, sinceS: t.at() / 1000 - 86_400 };
    expect(await t.keeper.tick()).toMatchObject({ plan: "swap" });
  });

  it("counts a swap against the 24 h cap by what is known: unknown at its ceiling, not sent or reverted at 0", async () => {
    t.chain.swapMode = "not_sent";
    await t.keeper.tick();
    expect(t.keeper.spentDay()).toBe(0n);
    t.chain.swapMode = "revert";
    await t.keeper.tick();
    expect(t.keeper.spentDay()).toBe(0n); // reverts never fill the cap (staging's thin pool)
    t.chain.allowance = 0n;
    t.chain.balances.set(KEEPER, parseEther("0.001")); // (refund the failed attempts' gas, to compare ceilings)
    t.chain.swapMode = "timeout";
    await t.keeper.tick();
    expect(t.keeper.spentDay()).toBe(SWAP_MAX);
    t.chain.mine();
    t.chain.swapMode = "ok";
    t.chain.balances.set(KEEPER, parseEther("0.001")); // (as if the mined ETH were spent elsewhere)
    t.chain.allowance = 0n;
    await t.keeper.tick();
    expect(t.keeper.spentDay()).toBe(SWAP_MAX + SWAP_ORACLE + 5_000n); // a mined swap counts what it took
  });

  it("SIGTERM while the approve is mining: the swap is never broadcast", async () => {
    t.chain.onApprove = () => t.keeper.requestStop();
    expect(await t.keeper.tick()).toEqual({ ok: false, error: "stopped after approve; the next start withdraws the allowance" });
    expect(t.chain.calls).toEqual([`approve ${SWAP_MAX}`]); // no swap
    expect(t.keeper.spentDay()).toBe(0n);
    // The next process withdraws the approval first, then does the whole top-up.
    const next = new Keeper(t.chain, limits, { metrics: new Metrics(), log: silent, alerts: t.alerts, now: t.at });
    t.chain.calls = [];
    expect(await next.tick()).toEqual({ ok: true, plan: "swap" });
    expect(t.chain.calls[0]).toBe("reset");
  });

  it("SIGTERM during the in-flight check: the leftover allowance reset never starts", async () => {
    t.chain.allowance = 5n;
    const real = t.chain.hasPendingTx.bind(t.chain);
    t.chain.hasPendingTx = async () => {
      t.keeper.requestStop();
      return real();
    };
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(t.chain.calls).toEqual([]);
  });

  it("a transaction pending at the first check but mined during the reads still stops this tick", async () => {
    t.chain.mempool.push(() => {});
    const real = t.chain.ethBalance.bind(t.chain);
    t.chain.ethBalance = async (who: Address) => {
      t.chain.mine(); // lands while balances are being read
      return real(who);
    };
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "pending" });
    expect(t.chain.calls).toEqual([]);
  });

  it("a stuck transaction doesn't hide a draining facilitator, a low float, or a keeper out of gas", async () => {
    t.chain.mempool.push(() => {});
    t.chain.balances.set(FACILITATOR, parseEther("0.0009"));
    t.chain.usdcHeld = usdc(5);
    t.chain.balances.set(KEEPER, TX_COST - 1n);
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "pending" });
    expect(t.alerts.activeReasons()).toEqual(expect.arrayContaining(["facilitator_below_min", "float_low", "keeper_gas_low"]));
  });

  it("SIGTERM during the quote: no approve, nothing counted against the cap", async () => {
    t.chain.onQuote = () => t.keeper.requestStop();
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(t.chain.calls).toEqual([]);
    expect(t.keeper.spentDay()).toBe(0n);
  });

  it("SIGTERM during the post-swap allowance reset: the send never starts", async () => {
    t.chain.onReset = () => t.keeper.requestStop();
    expect(await t.keeper.tick()).toEqual({ ok: false, error: "stopped before send; the next start sends the ETH" });
    expect(t.chain.calls).toEqual([`approve ${SWAP_MAX}`, `swap ${SWAP_ETH} max ${SWAP_MAX}`, "reset"]);
  });

  it("SIGTERM during a leftover reset ahead of a send: only the reset happens", async () => {
    t.chain.allowance = 5n;
    t.chain.balances.set(KEEPER, parseEther("0.0095")); // a send plan
    t.chain.onReset = () => t.keeper.requestStop();
    const r = await t.keeper.tick();
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^stopped before send/) });
    expect(t.chain.calls).toEqual(["reset"]);
  });

  it("a stopping keeper doesn't even withdraw a leftover allowance (that is a new transaction too)", async () => {
    t.chain.allowance = 5n;
    t.keeper.requestStop();
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(t.chain.calls).toEqual([]);
  });

  it("on shutdown, finishes the transaction in flight but starts no new one", async () => {
    t.chain.onSwap = () => t.keeper.requestStop(); // SIGTERM arrives while the swap is mining
    expect(await t.keeper.tick()).toEqual({ ok: false, error: "stopped after swap; the next start sends the ETH" });
    expect(t.chain.calls).toEqual([`approve ${SWAP_MAX}`, `swap ${SWAP_ETH} max ${SWAP_MAX}`]); // no reset, no send
    // The next process: withdraws the allowance, sends the ETH, no second swap.
    const next = new Keeper(t.chain, limits, { metrics: new Metrics(), log: silent, alerts: t.alerts, now: t.at });
    t.chain.calls = [];
    expect(await next.tick()).toEqual({ ok: true, plan: "send" });
    expect(t.chain.calls).toEqual(["reset", `send ${FACILITATOR} ${parseEther("0.008")}`]);
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "idle" }); // a stopping keeper plans nothing new
  });

  it("a refused quote or a failed quoter still sends held ETH, keeping the alert raised", async () => {
    t = setup({}, "https://alerts.example/hook");
    t.chain.balances.set(KEEPER, parseEther("0.0074")); // holds 86% of the 0.008 needed
    t.chain.quote = (ethOut) => usdcForWei(ethOut, PRICE) * 2n;
    const held = parseEther("0.0074") - limits.keeperReserveWei / 2n - 21_000n * GAS;
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "send" });
    expect(t.chain.calls).toEqual([`send ${FACILITATOR} ${held}`]);
    expect(t.alerts.activeReasons()).toContain("quote_above_oracle");
    expect(t.posted.filter((p) => p.reason === "quote_above_oracle")).toHaveLength(1);

    t = setup();
    t.chain.balances.set(KEEPER, parseEther("0.0074"));
    t.chain.quote = () => {
      throw new Error("quoter reverted");
    };
    expect(await t.keeper.tick()).toEqual({ ok: false, error: "quote: quoter reverted (sent held ETH instead)" });
    expect(t.chain.calls).toEqual([`send ${FACILITATOR} ${held}`]);
  });

  it("a sequencer outage alert stays raised across ticks while held ETH goes out (no flapping)", async () => {
    t = setup({}, "https://alerts.example/hook");
    t.chain.balances.set(KEEPER, parseEther("0.005"));
    t.chain.seq = { up: false, sinceS: NOW / 1000 - 86_400 };
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "send" });
    expect(t.alerts.activeReasons()).toContain("sequencer_down");
    t.chain.balances.set(FACILITATOR, parseEther("0.002")); // drains again
    t.chain.balances.set(KEEPER, parseEther("0.0001"));
    expect(await t.keeper.tick()).toMatchObject({ plan: "blocked", reason: "sequencer_down" });
    expect(t.posted.filter((p) => p.reason === "sequencer_down")).toHaveLength(1);
  });

  it("a wallet with code signs nothing, not even the leftover allowance reset", async () => {
    t.chain.allowance = 5n;
    t.chain.withCode.add(KEEPER);
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "blocked", reason: "wallet_has_code" });
    expect(t.chain.calls).toEqual([]);
  });

  it("refuses a swap when the pool quotes above the oracle ceiling, and alerts once", async () => {
    t = setup({}, "https://alerts.example/hook");
    t.chain.quote = (ethOut) => usdcForWei(ethOut, PRICE) * 2n;
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "blocked", reason: "quote_above_oracle" });
    await t.keeper.tick();
    expect(t.chain.calls).toEqual([]);
    expect(t.metrics.get("gas_keeper_blocked_total", { reason: "quote_above_oracle" })).toBe(2);
    expect(t.posted.filter((p) => p.reason === "quote_above_oracle")).toHaveLength(1);

    t.chain.quote = (ethOut) => usdcForWei(ethOut, PRICE);
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "swap" });
    expect(t.alerts.activeReasons()).not.toContain("quote_above_oracle");
    expect(t.metrics.get("gas_keeper_alert_active", { reason: "quote_above_oracle" })).toBe(0);
  });

  it("alerts after repeated failures, and clears once a tick succeeds", async () => {
    t = setup({}, "https://alerts.example/hook");
    t.chain.swapMode = "revert";
    for (let i = 0; i < 2; i++) expect(await t.keeper.tick()).toMatchObject({ ok: false });
    expect(t.alerts.activeReasons()).not.toContain("topup_failing");
    await t.keeper.tick();
    expect(t.posted).toContainEqual(expect.objectContaining({ reason: "topup_failing" }));
    t.chain.swapMode = "ok";
    expect(await t.keeper.tick()).toMatchObject({ ok: true, plan: "swap" });
    expect(t.alerts.activeReasons()).not.toContain("topup_failing");
  });

  it("alerts when a transaction stays stuck in flight", async () => {
    t.chain.mempool.push(() => {});
    for (let i = 0; i < 3; i++) expect(await t.keeper.tick()).toEqual({ ok: true, plan: "pending" });
    expect(t.alerts.activeReasons()).toContain("tx_stuck");
    t.chain.mine();
    await t.keeper.tick();
    expect(t.alerts.activeReasons()).not.toContain("tx_stuck");
  });

  it("alerts when the facilitator is below its own minimum (it has stopped settling)", async () => {
    t.chain.balances.set(FACILITATOR, parseEther("0.0009"));
    t.chain.quote = () => usdc(1_000); // blocked, so it stays low
    await t.keeper.tick();
    expect(t.alerts.activeReasons()).toEqual(expect.arrayContaining(["facilitator_below_min", "quote_above_oracle"]));
  });

  it("moves nothing while either wallet has code (e.g. an EIP-7702 sweeper delegation on a leaked key)", async () => {
    t.chain.withCode.add(KEEPER);
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "blocked", reason: "wallet_has_code" });
    t.chain.withCode = new Set([FACILITATOR]);
    t.chain.balances.set(KEEPER, parseEther("0.0095")); // even a plain send is refused
    expect(await t.keeper.tick()).toEqual({ ok: true, plan: "blocked", reason: "wallet_has_code" });
    expect(t.chain.calls).toEqual([]);
  });

  it("runs one tick at a time, and idle() waits for the one in flight", async () => {
    let release!: () => void;
    t.chain.swapGate = new Promise((r) => (release = r));
    const first = t.keeper.tick();
    await vi.waitFor(() => expect(t.chain.calls).toHaveLength(2)); // approve, swap (held)
    expect(await t.keeper.tick()).toBeNull();
    let idle = false;
    const waiting = t.keeper.idle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(await first).toEqual({ ok: true, plan: "swap" });
  });

  it("reports a failed chain read as a failed tick, touching nothing", async () => {
    t.chain.failRead = true;
    expect(await t.keeper.tick()).toEqual({ ok: false, error: "read: rpc down" });
    expect(t.chain.calls).toEqual([]);
    expect(t.metrics.get("gas_keeper_ticks_total", { result: "error" })).toBe(1);
  });

  it("alerts when one settle costs more than the allowance net of VAT", async () => {
    t = setup({}, "https://alerts.example/hook");
    t.chain.balances.set(FACILITATOR, parseEther("0.02"));
    await t.keeper.tick();
    expect(t.metrics.get("gas_keeper_settle_cost_usd")).toBeCloseTo(0.00103, 6);
    expect(t.metrics.get("gas_keeper_settle_cost_over_allowance")).toBe(0);
    // 0.0098 gwei: $0.00168 per settle. Under the gross $0.002, but over the $0.001666 net of VAT.
    t.chain.gasPrice = 9_800_000n;
    await t.keeper.tick();
    expect(t.metrics.get("gas_keeper_settle_cost_over_allowance")).toBe(1);
    expect(t.posted).toEqual([expect.objectContaining({ reason: "settle_cost_over_allowance", text: expect.stringMatching(/net of VAT\) on eip155:8453$/) })]);
    t.chain.gasPrice = GAS;
    await t.keeper.tick();
    expect(t.alerts.activeReasons()).not.toContain("settle_cost_over_allowance");
  });

  it("alerts when the float runs low, so the operator moves more USDC in from the treasury", async () => {
    t.chain.usdcHeld = usdc(9.99);
    t.chain.balances.set(FACILITATOR, parseEther("0.02"));
    await t.keeper.tick();
    expect(t.alerts.activeReasons()).toEqual(["float_low"]);
  });
});

describe("WebhookAlerts", () => {
  it("retries an alert whose delivery failed on the next raise, and sends a delivered one once", async () => {
    const metrics = new Metrics();
    let fail = true;
    const sent: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init!.body)).reason);
      return new Response("", { status: fail ? 503 : 200 });
    }) as unknown as typeof fetch;
    const a = new WebhookAlerts({ url: "https://alerts.example/hook", network: "eip155:8453", metrics, log: silent, fetch: f });
    a.raise("facilitator_below_min", "low", {});
    await vi.waitFor(() => expect(metrics.get("gas_keeper_alert_webhook_failed_total", { reason: "facilitator_below_min" })).toBe(1));
    fail = false;
    a.raise("facilitator_below_min", "low", {}); // next tick, condition still holds
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    a.raise("facilitator_below_min", "low", {});
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(2); // delivered: not repeated
  });

  it("keeps an alert visible while its webhook is down, and zeroes it on clear even if never delivered", async () => {
    const metrics = new Metrics();
    const a = new WebhookAlerts({ url: "https://alerts.example/hook", network: "eip155:8453", metrics, log: silent, fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    a.raise("facilitator_below_min", "low", {});
    await vi.waitFor(() => expect(metrics.get("gas_keeper_alert_webhook_failed_total", { reason: "facilitator_below_min" })).toBe(1));
    expect(a.activeReasons()).toEqual(["facilitator_below_min"]); // /readyz still shows it
    expect(metrics.get("gas_keeper_alert_active", { reason: "facilitator_below_min" })).toBe(1);
    a.clear("facilitator_below_min");
    expect(metrics.get("gas_keeper_alert_active", { reason: "facilitator_below_min" })).toBe(0);
    expect(a.activeReasons()).toEqual([]);
  });

  it("a delivery for an earlier activation doesn't mark a re-raised alert as delivered", async () => {
    const metrics = new Metrics();
    let release!: () => void;
    const sent: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init!.body)).reason);
      if (sent.length === 1) await new Promise<void>((r) => (release = r));
      return new Response("");
    }) as unknown as typeof fetch;
    const a = new WebhookAlerts({ url: "https://alerts.example/hook", network: "eip155:8453", metrics, log: silent, fetch: f });
    a.raise("float_low", "low", {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    a.clear("float_low");
    a.raise("float_low", "low again", {}); // new activation while the first POST is in flight
    release();
    await new Promise((r) => setTimeout(r, 5));
    a.raise("float_low", "low again", {}); // next tick: must still send for this activation
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });

  it("counts a webhook that fails or answers non-2xx, and never throws", async () => {
    const metrics = new Metrics();
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const a = new WebhookAlerts({ url: "https://alerts.example/hook", network: "eip155:8453", metrics, log: silent, fetch: failing });
    expect(() => a.raise("float_low", "low", {})).not.toThrow();
    const bad = new WebhookAlerts({ url: "https://alerts.example/hook", network: "eip155:8453", metrics, log: silent, fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    bad.raise("tx_stuck", "stuck", {});
    await vi.waitFor(() => expect(metrics.get("gas_keeper_alert_webhook_failed_total", { reason: "float_low" })).toBe(1));
    await vi.waitFor(() => expect(metrics.get("gas_keeper_alert_webhook_failed_total", { reason: "tx_stuck" })).toBe(1));
  });
});

describe("startLoop", () => {
  it("ticks, and stop() waits for the tick in flight before returning", async () => {
    let release!: () => void;
    let ticks = 0;
    let inFlight: Promise<void> | null = null;
    let stopRequested = false;
    const keeper = {
      requestStop: () => {
        stopRequested = true;
      },
      tick: async () => {
        ticks++;
        inFlight = new Promise<void>((r) => (release = r));
        await inFlight;
        inFlight = null;
        return { ok: true as const, plan: "idle" as const };
      },
      idle: async () => {
        await inFlight;
      },
    };
    const loop = startLoop(keeper, { intervalMs: 10_000, startDelayMs: 0 }, silent);
    await vi.waitFor(() => expect(ticks).toBe(1));
    let stopped = false;
    const stopping = loop.stop(5_000).then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(stopped).toBe(false);
    expect(stopRequested).toBe(true);
    release();
    await stopping;
    expect(ticks).toBe(1); // no new tick after stop
  });

  it("waits out the start delay before the first tick (the old deployment is still draining)", async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const keeper = { requestStop: () => {}, idle: async () => {}, tick: async () => (ticks++, null) };
      const loop = startLoop(keeper, { intervalMs: 60_000, startDelayMs: 120_000 }, silent);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(ticks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks).toBe(1);
      await loop.stop(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HTTP", () => {
  it("is healthy always, ready only while ticks keep completing", async () => {
    const t = setup();
    let now = NOW;
    const app = createApp({ keeper: t.keeper, alerts: t.alerts, metrics: t.metrics, intervalMs: 60_000, now: () => now });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(503);
    await t.keeper.tick();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, last: { ok: true, plan: "swap" }, alerts: [] });
    now += 180_001;
    expect((await app.request("/readyz")).status).toBe(503);
    expect(await (await app.request("/metrics")).text()).toMatch(/gas_keeper_settle_cost_usd/);
  });
});

describe("config", () => {
  const env = {
    RPC_URL: "https://mainnet.base.org",
    NETWORK: "eip155:8453",
    KEEPER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    FACILITATOR_ADDRESS: FACILITATOR.toLowerCase(),
  };

  it("parses amounts exactly", () => {
    const c = loadConfig(env);
    expect(c.FACILITATOR_ADDRESS).toBe(FACILITATOR);
    expect(c.FACILITATOR_MIN_ETH).toBe(parseEther("0.001"));
    expect(c.TOPUP_TRIGGER_ETH).toBe(parseEther("0.003"));
    expect(c.TOPUP_TARGET_ETH).toBe(parseEther("0.01"));
    expect(c.MAX_USDC_PER_TOPUP).toBe(usdc(50));
    expect(c.PRICE_MAX_AGE_S).toBe(1800);
    expect(c.POOL_FEE).toBe(500);
  });

  it.each([
    [{ TOPUP_TARGET_ETH: "0.003" }, /TOPUP_TARGET_ETH: must be above/],
    [{ TOPUP_TARGET_ETH: "0.0035" }, /TOPUP_TARGET_ETH: must be at least KEEPER_RESERVE_ETH above/],
    [{ TOPUP_TRIGGER_ETH: "0.001" }, /TOPUP_TRIGGER_ETH: must be above FACILITATOR_MIN_ETH/],
    [{ MAX_USDC_PER_TOPUP: "200" }, /MAX_USDC_PER_TOPUP: must not exceed/],
    [{ MAX_USDC_PER_TOPUP: "0" }, /MAX_USDC_PER_TOPUP: must be more than 0/],
    [{ MAX_USDC_PER_DAY: "0" }, /MAX_USDC_PER_DAY: must be more than 0/],
    [{ MAX_SLIPPAGE_BPS: "501" }, /MAX_SLIPPAGE_BPS/],
    [{ MAX_SLIPPAGE_BPS: "49" }, /MAX_SLIPPAGE_BPS: must be at least 50 bps/],
    [{ POOL_FEE: "10000", MAX_SLIPPAGE_BPS: "109" }, /must be at least 110 bps/],
    [{ NODE_ENV: "production", START_DELAY_MS: "100000" }, /START_DELAY_MS: must be at least SHUTDOWN_WAIT_MS \+ 30000/],
    [{ POOL_FEE: "250" }, /POOL_FEE: a Uniswap v3 fee tier/],
    [{ KEEPER_RESERVE_ETH: "0.0003" }, /KEEPER_RESERVE_ETH: must be at least 0.0004/],
    [{ PRICE_MAX_AGE_S: "86401" }, /PRICE_MAX_AGE_S/],
    [{ PRICE_MAX_AGE_S: "1499" }, /PRICE_MAX_AGE_S/], // under the feed's heartbeat: would block most swaps
    [{ FACILITATOR_ADDRESS: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" }, /must not be the keeper's own address/],
    [{ KEEPER_PRIVATE_KEY: "0x1234" }, /KEEPER_PRIVATE_KEY/],
    [{ TOPUP_TRIGGER_ETH: "1e-3" }, /TOPUP_TRIGGER_ETH/],
  ])("refuses %o", (over, msg) => {
    expect(() => loadConfig({ ...env, ...over })).toThrow(msg);
  });
});
