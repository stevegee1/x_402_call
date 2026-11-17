import { describe, expect, it } from "vitest";
import { cleanMarketIndex, cleanSystemPrices, ELEXON_MARKET_INDEX, ELEXON_SYSTEM_PRICES, ElexonClient } from "../src";

// Live shapes, 2026-11-17.
const sp = (settlementDate: string, settlementPeriod: unknown, startTime: unknown, ssp: unknown = 188, sbp: unknown = 188) => ({ settlementDate, settlementPeriod, startTime, systemSellPrice: ssp, systemBuyPrice: sbp, priceDerivationCode: "P" });
const mid = (dataProvider: string, settlementPeriod: number, startTime: string, price: number, volume: number) => ({ dataset: "MID", startTime, dataProvider, settlementDate: "2026-11-17", settlementPeriod, price, volume });

describe("Elexon system prices", () => {
  it("places each period by settlement date and period, cross-checked against startTime", () => {
    const r = cleanSystemPrices([sp("2026-11-17", 1, "2026-11-17T00:00:00Z"), sp("2026-11-17", 25, "2026-11-17T12:00:00Z", 190.5, 191)]);
    expect(r.dropped).toBe(0);
    expect(r.observations.map((o) => [new Date(o.validFrom).toISOString(), o.region, o.value])).toEqual([
      ["2026-11-17T00:00:00.000Z", "ssp", 188],
      ["2026-11-17T00:00:00.000Z", "sbp", 188],
      ["2026-11-17T12:00:00.000Z", "ssp", 190.5],
      ["2026-11-17T12:00:00.000Z", "sbp", 191],
    ]);
  });

  it("in BST, SP 1 starts at 23:00 UTC the day before; a disagreeing startTime is dropped", () => {
    expect(cleanSystemPrices([sp("2026-07-01", 1, "2026-06-30T23:00:00Z")]).observations[0]!.validFrom).toBe(Date.parse("2026-06-30T23:00:00Z"));
    const bad = cleanSystemPrices([sp("2026-07-01", 1, "2026-07-01T00:00:00Z"), sp("2026-11-17", 49, "2026-11-18T00:00:00Z"), sp("2026-11-17", 1, "2026-11-17T00:00:00")]);
    expect(bad.dropped).toBe(3);
  });

  it("keeps negative prices and rejects impossible ones", () => {
    const r = cleanSystemPrices([sp("2026-11-17", 3, "2026-11-17T01:00:00Z", -45.2, 50_000)]);
    expect(r.observations.map((o) => [o.region, o.quality, o.value])).toEqual([
      ["ssp", "ok", -45.2],
      ["sbp", "rejected", null],
    ]);
  });
});

describe("Elexon market index", () => {
  it("keeps APX only, and stores a period with no trades as missing, never a zero price", () => {
    const r = cleanMarketIndex([
      mid("APXMIDP", 25, "2026-11-17T12:00:00Z", 189.1, 3530.9),
      mid("N2EXMIDP", 25, "2026-11-17T12:00:00Z", 0, 0),
      mid("APXMIDP", 26, "2026-11-17T12:30:00Z", 0, 0),
    ]);
    expect(r.observations.map((o) => [new Date(o.validFrom).toISOString(), o.region, o.value, o.quality])).toEqual([
      ["2026-11-17T12:00:00.000Z", "apx", 189.1, "ok"],
      ["2026-11-17T12:30:00.000Z", "apx", null, "missing"],
    ]);
    expect(r.dropped).toBe(0);
  });

  it("is registered as Elexon datasets with a 5-minute minimum fetch interval", () => {
    for (const d of [ELEXON_SYSTEM_PRICES, ELEXON_MARKET_INDEX]) expect(d).toMatchObject({ source: "elexon", unit: "GBP/MWh", minFetchIntervalMs: 300_000 });
  });
});

describe("ElexonClient", () => {
  it("reads today and yesterday by UK settlement date, and a 48 h window for ranged datasets", () => {
    const c = new ElexonClient({ baseUrl: "https://elexon.example", now: () => Date.parse("2026-07-01T23:30:00Z") }); // 00:30 BST on 2 July
    expect(c.paths("/x/{date}?format=json")).toEqual(["/x/2026-07-01?format=json", "/x/2026-07-02?format=json"]);
    expect(c.paths("/y?from={from}&to={to}")).toEqual(["/y?from=2026-06-29T23:30:00Z&to=2026-07-02T00:30:00Z"]);
  });

  it("concatenates each path's data, and throws on HTTP errors or a body with no data", async () => {
    const urls: string[] = [];
    const seq = [new Response(JSON.stringify({ data: [1] })), new Response(JSON.stringify({ data: [2, 3] })), new Response("busy", { status: 503 }), new Response(JSON.stringify({}))];
    const c = new ElexonClient({ baseUrl: "https://elexon.example", now: () => Date.parse("2026-11-17T12:00:00Z"), fetchImpl: (async (u: URL) => (urls.push(String(u)), seq.shift()!)) as unknown as typeof fetch });
    expect(await c.records("/s/{date}")).toEqual([1, 2, 3]);
    expect(urls).toEqual(["https://elexon.example/bmrs/api/v1/s/2026-11-16", "https://elexon.example/bmrs/api/v1/s/2026-11-17"]);
    await expect(c.records("/s?from={from}&to={to}")).rejects.toThrow(/HTTP 503/);
    await expect(c.records("/s?from={from}&to={to}")).rejects.toThrow(/unexpected response/);
    expect(await c.lastModified()).toBeNull();
  });
});
