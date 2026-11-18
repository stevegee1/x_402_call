import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingProduct, TRADING_LIMITS } from "../../../src/products/trading";
import { TRADING_DATASETS } from "../../../src/products/trading/datasets";
import { TradingUpdates } from "../../../src/products/trading/updates";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, type TestEnv } from "../../helpers";
import { CUR, DAY, GEN_LAST, H, MultiFakeStore, OLD, P, storeRows, T0, tradingSources, value } from "./fixtures";

const T = `${BASE_URL}/v1/trading`;
const iso = (t: number) => new Date(t).toISOString();

/** Reads server-sent events from a streaming response as they arrive. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(timeoutMs = 2_000): Promise<{ event: string; data: any } | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          return { event: /^event: (.*)$/m.exec(raw)?.[1] ?? "message", data: JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? "null") };
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), left))]);
        if (r === null || r.done) return null;
        buf += dec.decode(r.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

describe("trading feed: every NESO and Elexon series, point-in-time, on the three rails", () => {
  let env: TestEnv;
  let store: MultiFakeStore;
  let ingestAt: Map<string, number | null>;
  let updates: TradingUpdates;
  let caches: Awaited<ReturnType<typeof tradingSources>>["caches"];

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    store = new MultiFakeStore(storeRows());
    ingestAt = new Map();
    const built = await tradingSources(store, ingestAt);
    caches = built.caches;
    updates = new TradingUpdates();
    env = await createTestEnv({}, { products: [new TradingProduct(built.sources, Date.now, updates)], sessions: true });
  });
  afterEach(() => vi.useRealTimers());

  const paying = (fetchImpl = env.fetch) =>
    createPolicyClient({
      policy: { agentId: "t", maxPricePerRequestUsd: 25, dailyBudgetUsd: 100, dailyBudgetGbp: 100, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: fetchImpl,
    });
  const payments = () => env.store.listPayments({ limit: 100 });
  async function creditsKey(netGbp = 5) {
    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Quant Ltd", email: "q@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: netGbp, reference: "t" }) });
    return signup.api_key as string;
  }
  const balance = async (key: string) => (await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_gbp as number;
  const withKey = (key: string, url: string) => env.fetch(url, { headers: { authorization: `Bearer ${key}` } });

  it("lists every dataset free: series, where each history starts, prices and the licence wording", async () => {
    const res = await env.fetch(`${T}/datasets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: { key: string }) => d.key)).toEqual(TRADING_DATASETS.map((d) => d.key));
    const carbon = body.data.find((d: { key: string }) => d.key === "carbon_intensity");
    expect(carbon).toMatchObject({ unit: "gCO2/kWh", period_minutes: 30, fresh: true, kind: "forecast", source: { attribution: "Supported by National Energy SO Open Data" } });
    expect(carbon.series).toEqual([
      { id: "england", history_from: iso(OLD) },
      { id: "scotland", history_from: iso(CUR - 2 * H) },
      { id: "wales", history_from: iso(CUR - 2 * H) },
    ]);
    expect(carbon.endpoints.map((e: { id: string; price_usdc: string }) => [e.id, e.price_usdc])).toEqual([
      ["trading.latest", "0.012"],
      ["trading.history", "0.052"],
      ["trading.revisions", "0.022"],
      ["trading.stream", "0.012"],
    ]);
    const prices = body.data.find((d: { key: string }) => d.key === "system_prices");
    expect(prices.source.attribution).toBe("Contains BMRS data © Elexon Limited copyright and database right 2026");
    const products = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    expect(products.data.find((p: { id: string }) => p.id === "trading").description).toMatch(/point-in-time/);
  });

  it("asks for payment with all three rails at Grid's prices, and charges nothing to ask", async () => {
    const res = await env.fetch(`${T}/wind_forecast_14d/latest`);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts[0].amount).toBe("12000"); // $0.012 in USDC atomic units
    expect(body.credits.price_gbp).toBe(0.01);
    expect(body.sessions).toBeDefined();
    expect(await payments()).toHaveLength(0);
  });

  it("latest: each series' newest period at or before now, its latest version (the revision), with known_at", async () => {
    const res = await paying().fetch(`${T}/embedded_wind_solar/latest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dataset: "embedded_wind_solar", unit: "MW", kind: "forecast", mode: "live", generated_at: iso(T0) });
    expect(body.data).toEqual(
      ["wind", "wind_capacity", "solar", "solar_capacity"].map((s, i) => ({ series: s, from: iso(CUR), value: value(CUR, i), quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) })),
    );
    // Async mode: armed once the response went out, settled by the worker shortly after (I15).
    expect((await payments()).map((p) => [p.endpoint, p.status])).toEqual([["trading.latest", "verified"]]);
  });

  it("latest for an outturn dataset published 12 days late is still a memory read", async () => {
    const body = await (await paying().fetch(`${T}/generation_mix/latest`)).json();
    expect(body.data[0]).toMatchObject({ series: "gas", from: iso(GEN_LAST), value: value(GEN_LAST, 0) });
    expect(store.calls).toEqual([]); // nothing went to Postgres
  });

  it("latest for prices: Elexon attribution on every response", async () => {
    const body = await (await paying().fetch(`${T}/system_prices/latest`)).json();
    expect(body.data.map((d: { series: string; from: string }) => [d.series, d.from])).toEqual([
      ["ssp", iso(CUR)],
      ["sbp", iso(CUR)],
    ]);
    expect(body.source.attribution).toMatch(/^Contains BMRS data © Elexon Limited/);
  });

  it("history ahead of now returns the current forecast; as_of returns what was known then (no look-ahead)", async () => {
    const client = paying();
    const now = await (await client.fetch(`${T}/wind_forecast_14d/wind/history?from=${iso(CUR + 24 * H)}&to=${iso(CUR + 25 * H)}`)).json();
    expect(now.data).toEqual([
      { from: iso(CUR + 24 * H), value: value(CUR + 24 * H, 0), quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) },
      { from: iso(CUR + 24 * H + P), value: value(CUR + 24 * H + P, 0), quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) },
    ]);
    const then = await (await client.fetch(`${T}/wind_forecast_14d/wind/history?from=${iso(CUR + 24 * H)}&to=${iso(CUR + 25 * H)}&as_of=${iso(T0 - 90 * 60_000)}`)).json();
    expect(then.as_of).toBe(iso(T0 - 90 * 60_000));
    expect(then.data.map((d: { value: number }) => d.value)).toEqual([value(CUR + 24 * H, 0) + 5, value(CUR + 24 * H + P, 0) + 5]); // the first version
    expect(store.calls).toEqual([]); // both answered from memory
  });

  it("history older than the memory window comes from Postgres, same shape", async () => {
    const body = await (await paying().fetch(`${T}/carbon_intensity/england/history?from=${iso(OLD)}&to=${iso(OLD + H)}`)).json();
    expect(body.data).toEqual([{ from: iso(OLD), value: 111, quality: "ok", known_at: iso(OLD - H), published_at: iso(OLD - H - 20_000) }]);
    expect(store.calls).toEqual(["asOf:neso.carbon_intensity"]);
  });

  it("a range with no data is refused 404 and not charged, and says where history starts", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    const res = await withKey(key, `${T}/demand_forecast_2_14d/gb/history?from=${iso(CUR - 5 * DAY)}&to=${iso(CUR - 4 * DAY)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_history", history_from: iso(CUR - 2 * H) });
    expect(await balance(key)).toBe(before);
  });

  it("history: bad parameters are refused before any charge", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    for (const q of ["", "?from=2026-11-17T00:00:00", `?from=${iso(CUR)}&to=${iso(CUR - P)}`, `?from=${iso(CUR - 8 * DAY)}&to=${iso(CUR)}`, `?from=${iso(CUR)}&as_of=${iso(T0 + H)}`]) {
      const res = await withKey(key, `${T}/market_index/apx/history${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error).toBe("invalid_parameters");
    }
    expect(await balance(key)).toBe(before);
  });

  it("revisions: every version of one period, oldest first", async () => {
    const body = await (await paying().fetch(`${T}/system_prices/sbp/revisions?period=${iso(CUR - H)}`)).json();
    expect(body).toMatchObject({ dataset: "system_prices", series: "sbp", period: iso(CUR - H), count: 2 });
    expect(body.revisions.map((r: { value: number; known_at: string }) => [r.value, r.known_at])).toEqual([
      [value(CUR - H, 1) + 5, iso(T0 - 2 * H)],
      [value(CUR - H, 1), iso(T0 - H)],
    ]);
  });

  it("revisions: a period off the half-hour grid is refused before any charge", async () => {
    const res = await paying().fetch(`${T}/system_prices/sbp/revisions?period=${iso(CUR + 15 * 60_000)}`);
    expect(res.status).toBe(400);
    expect(await payments()).toHaveLength(0);
  });

  it("unknown datasets and series are 404 and never charged", async () => {
    const client = paying();
    const a = await client.fetch(`${T}/ea_flood/latest`);
    expect(a.status).toBe(404);
    expect((await a.json()).datasets).toContain("system_prices");
    const b = await client.fetch(`${T}/system_prices/apx/history?from=${iso(CUR)}`); // apx is market_index's series
    expect(b.status).toBe(404);
    expect(await b.json()).toMatchObject({ error: "unknown_series", series: ["ssp", "sbp"] });
    expect(await payments()).toHaveLength(0);
  });

  it("a dataset whose ingest stopped is stale: 503, never charged, while the others still sell", async () => {
    ingestAt.set("system_prices", T0 - TRADING_LIMITS.maxIngestAgeMs - 1);
    const key = await creditsKey();
    const before = await balance(key);
    const stale = await withKey(key, `${T}/system_prices/latest`);
    expect(stale.status).toBe(503);
    expect((await stale.json()).error).toBe("data_stale");
    expect(await balance(key)).toBe(before);
    expect((await withKey(key, `${T}/market_index/latest`)).status).toBe(200);
    expect(await balance(key)).toBeCloseTo(before - 0.01, 6);
    const status = await (await env.fetch(`${BASE_URL}/status`)).json();
    const trading = status.products.find((p: { id: string }) => p.id === "trading");
    expect(trading.scopes.find((s: { scope: string }) => s.scope === "system_prices")).toMatchObject({ fresh: false, reason: "ingest has not fetched recently" });
  });

  it("a store outage on an old-history read answers 503 and refunds credits", async () => {
    store.down = true;
    const key = await creditsKey();
    const before = await balance(key);
    const res = await withKey(key, `${T}/carbon_intensity/england/history?from=${iso(OLD)}`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("history_unavailable");
    expect(await balance(key)).toBe(before);
  });

  it("credits pay the exact GBP price for each resource", async () => {
    const key = await creditsKey();
    const before = await balance(key);
    expect((await withKey(key, `${T}/regional_carbon_intensity/london/history?from=${iso(CUR)}`)).status).toBe(200);
    expect((await withKey(key, `${T}/regional_carbon_intensity/london/revisions?period=${iso(CUR)}`)).status).toBe(200);
    expect(await balance(key)).toBeCloseTo(before - 0.042 - 0.017, 6);
  });

  it("the home page sells it as the trading product, and every page carries both licence lines", async () => {
    const home = await (await env.fetch(`${BASE_URL}/`, { headers: { accept: "text/html" } })).text();
    expect(home).toContain("Intelligence for AI trading platforms");
    expect(home).toContain("Imbalance and market index prices");
    expect(home).toContain("Supported by National Energy SO Open Data");
    expect(home).toContain("Contains BMRS data © Elexon Limited copyright and database right 2026");
    const docs = await (await env.fetch(`${BASE_URL}/docs`, { headers: { accept: "text/html" } })).text();
    expect(docs).toContain("Contains BMRS data © Elexon Limited");
    expect(docs).toContain("/v1/trading/{dataset}/{series}/history");
  });

  describe("stream", () => {
    async function session() {
      const s = await (await paying().fetch(`${BASE_URL}/v1/sessions/usd1`)).json();
      return { token: s.session_token as string, id: s.session_id as string };
    }
    const spent = async (id: string) => {
      await env.deps.sessions!.flush();
      return (await env.store.getSession(id))?.spentAtomic ?? 0n;
    };

    it("sends the live view on connect and on each new version, charged per event from the session", async () => {
      const { token, id } = await session();
      const res = await env.fetch(`${T}/system_prices/stream`, { headers: { authorization: `Session ${token}` } });
      expect(res.status).toBe(200);
      const events = sse(res);
      const first = await events.next();
      expect(first!.event).toBe("live");
      expect(first!.data.data.map((s: { series: string; data: unknown[] }) => [s.series, s.data.length])).toEqual([
        ["ssp", 1],
        ["sbp", 1],
      ]); // prices: the current period only, nothing ahead
      // A new settlement-run revision of the current period lands.
      store.append("elexon.system_prices", "ssp", CUR, 999, T0);
      await caches.get("system_prices")!.refresh();
      updates.publish("system_prices");
      const second = await events.next();
      expect(second!.data.data[0].data[0]).toMatchObject({ from: iso(CUR), value: 999, known_at: iso(T0) });
      expect(await spent(id)).toBe(24_000n);
      // Another dataset's update is not this stream's event.
      updates.publish("market_index");
      expect(await events.next(200)).toBeNull();
      await events.cancel();
      await vi.waitFor(() => expect(updates.subscriberCount("system_prices")).toBe(0));
    });

    it("a forecast stream carries every period ahead", async () => {
      const { token } = await session();
      const events = sse(await env.fetch(`${T}/wind_forecast_14d/stream`, { headers: { authorization: `Session ${token}` } }));
      const first = await events.next();
      expect(first!.data.data[0].data).toHaveLength(97); // the current period and 48 h ahead in the fixture
      await events.cancel();
    });

    it("needs a session: an API key is not a way to pay for a stream, and nothing is charged", async () => {
      const key = await creditsKey();
      const before = await balance(key);
      const r = await withKey(key, `${T}/system_prices/stream`);
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe("session_required");
      expect(await balance(key)).toBe(before);
    });
  });
});

describe("trading feed without sessions", () => {
  it("does not offer the stream", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    try {
      const { sources } = await tradingSources(new MultiFakeStore(storeRows()), new Map());
      const p = new TradingProduct(sources, Date.now);
      expect(p.resources.map((r) => r.id)).toEqual(["trading.latest", "trading.history", "trading.revisions"]);
      expect(p.description).not.toMatch(/push stream/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to start with a dataset missing", async () => {
    const { sources } = await tradingSources(new MultiFakeStore(storeRows()), new Map());
    sources.delete("market_index");
    expect(() => new TradingProduct(sources)).toThrow(/no source for market_index/);
  });
});
