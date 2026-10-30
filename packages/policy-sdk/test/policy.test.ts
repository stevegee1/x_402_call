import { describe, expect, it } from "vitest";
import { BuyerBreakers, DEFAULT_BREAKERS, evaluateStatic, toAccrualLines, toCsv, type Policy, type SpendRecord } from "../src";

const policy: Policy = {
  agentId: "ops-agent",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: ["https://api.example.com"],
  breakers: { ...DEFAULT_BREAKERS, velocity: { maxPayments: 3, windowMs: 1_000 }, perUrl: { maxPayments: 2, windowMs: 1_000 }, cooldownMs: 10_000 },
};

const ctx = {
  url: "https://api.example.com/v1/dover/vessels",
  origin: "https://api.example.com",
  network: "eip155:84532",
  assetIsUsdc: true,
  payTo: "0xabc",
  priceUsd: 0.033,
  spentTodayUsd: 0,
};

describe("static policy", () => {
  it("allows a compliant payment", () => expect(evaluateStatic(policy, ctx)).toEqual({ allow: true }));
  it.each([
    [{ network: "eip155:1" }, "network_not_allowed"],
    [{ assetIsUsdc: false }, "asset_not_allowed"],
    [{ origin: "https://evil.example" }, "origin_not_allowed"],
    [{ priceUsd: 0.5 }, "price_above_max"],
    [{ spentTodayUsd: 4.99 }, "daily_budget_exceeded"],
  ])("denies %o with %s", (patch, code) => {
    expect(evaluateStatic(policy, { ...ctx, ...patch })).toMatchObject({ allow: false, code });
  });
});

describe("breakers", () => {
  it("detects loops on the same URL", () => {
    const b = new BuyerBreakers(policy.breakers);
    b.recordPayment("u1", 0.03, 0);
    b.recordPayment("u1", 0.03, 10);
    expect(b.check("u1", "o", 0.03, 20)).toMatchObject({ code: "loop_detected" });
    expect(b.check("u1", "o", 0.03, 2_000).allow).toBe(true);
  });

  it("opens the velocity breaker and holds it for the cooldown", () => {
    const b = new BuyerBreakers(policy.breakers);
    ["a", "b", "c"].forEach((u, i) => b.recordPayment(u, 0.03, i));
    expect(b.check("d", "o", 0.03, 5)).toMatchObject({ code: "velocity_breaker_open" });
    expect(b.check("d", "o", 0.03, 5_000)).toMatchObject({ code: "velocity_breaker_open" });
    expect(b.check("d", "o", 0.03, 20_000).allow).toBe(true);
  });

  it("blocks a seller after repeated paid failures", () => {
    const b = new BuyerBreakers(policy.breakers);
    for (let i = 0; i < 3; i++) b.recordOutcome("https://bad", false, 0);
    expect(b.check("x", "https://bad", 0.03, 1)).toMatchObject({ code: "seller_breaker_open" });
    expect(b.check("x", "https://good", 0.03, 1).allow).toBe(true);
  });

  it("flags price spikes", () => {
    const b = new BuyerBreakers(policy.breakers);
    b.recordPayment("u", 0.033, 0);
    expect(b.check("u2", "o", 0.033, 5_000).allow).toBe(true);
    expect(b.check("u", "o", 0.066, 5_000)).toMatchObject({ code: "price_spike" });
  });
});

describe("accrual export", () => {
  it("aggregates micro-payments per supplier/cost centre/currency", () => {
    const day = "2026-10-22";
    const ts = Date.parse(`${day}T10:00:00Z`);
    const base: SpendRecord = { ts, agentId: "a", rail: "x402", url: "u", origin: "https://api.example.com", amount: 0.033, currency: "USD", status: 200 };
    const records: SpendRecord[] = [base, { ...base, amount: 0.066 }, { ...base, rail: "credits", amount: 0.025, currency: "GBP" }, { ...base, ts: ts - 86_400_000 }];
    const lines = toAccrualLines(records, { day, companyCode: "GB01", glAccount: "6100000", defaultCostCentre: "CC-OPS", supplierMap: { "https://api.example.com": "V100" } });
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.TransactionCurrency === "USD")?.AmountInTransactionCurrency).toBe("0.099000");
    expect(toCsv(lines).split("\n")[0]).toContain("CompanyCode,DocumentDate");
  });
});
