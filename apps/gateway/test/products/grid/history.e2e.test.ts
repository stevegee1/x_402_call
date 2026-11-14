import { EnvCache } from "@mx/env";
import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridProduct } from "../../../src/products/grid";
import { GridFeed } from "../../../src/products/grid/feed";
import { GridHistory } from "../../../src/products/grid/history";
import { STORE_LIMITS, StoreGridSource } from "../../../src/products/grid/store-source";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, type TestEnv } from "../../helpers";
import { CUR, T0 } from "./fixtures";
import { FakeStore, storeRows } from "./store-fixtures";

const ADMIN = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };

const H = 3_600_000;
const P = 30 * 60_000;
const DAY = 24 * H;
const DS = "neso.carbon_intensity";
const G = `${BASE_URL}/v1/grid`;
const iso = (t: number) => new Date(t).toISOString();

describe("grid on the version store: live view, point-in-time history, revisions", () => {
  let env: TestEnv;
  let store: FakeStore;
  let cache: EnvCache;
  let feed: GridFeed;
  let ingestAt: number | null;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    store = new FakeStore(storeRows());
    cache = new EnvCache(store, { dataset: DS, regions: ["england", "scotland", "wales"], windowMs: 7 * DAY });
    await cache.refresh();
    ingestAt = T0 - 60_000;
    feed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => ingestAt }), { warn: () => {}, info: () => {} });
    await feed.poll();
    env = await createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store))] });
  });
  afterEach(() => vi.useRealTimers());

  const paying = () =>
    createPolicyClient({
      policy: { agentId: "t", maxPricePerRequestUsd: 0.1, dailyBudgetUsd: 5, dailyBudgetGbp: 5, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: env.fetch,
    });
  const payments = () => env.store.listPayments({ limit: 100 });
  async function creditsKey(netGbp = 5) {
    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Quant Ltd", email: "q@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: netGbp, reference: "t" }) });
    return signup.api_key as string;
  }
  const balance = async (key: string) => (await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_gbp;

  it("serves the live endpoints from the latest stored version", async () => {
    const now = await (await paying().fetch(`${G}/england/intensity`)).json();
    expect(now).toMatchObject({ intensity: 200, period: { from: iso(CUR) } }); // the revision, not the first forecast (205)
  });

  it("lists the history resources with their prices", async () => {
    const countries = await (await env.fetch(`${G}/countries`)).json();
    expect(countries.data[0].endpoints.map((e: { id: string; price_usdc: string }) => [e.id, e.price_usdc])).toEqual([
      ["grid.intensity", "0.012"],
      ["grid.forecast", "0.022"],
      ["grid.window", "0.052"],
      ["grid.history", "0.052"],
      ["grid.revisions", "0.022"],
    ]);
    const challenge = await env.fetch(`${G}/england/history?from=${iso(CUR)}`);
    expect(challenge.status).toBe(402);
    expect(decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!).accepts[0]!.amount).toBe("52000");
  });

  it("history: latest by default, and the version known at as_of when given", async () => {
    const client = paying();
    const latest = await (await client.fetch(`${G}/england/history?from=${iso(CUR)}&to=${iso(CUR + 2 * P)}`)).json();
    expect(latest).toMatchObject({ country: "england", from: iso(CUR), to: iso(CUR + 2 * P), as_of: null, count: 2 });
    expect(latest.data).toEqual([
      { from: iso(CUR), intensity: 200, quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) },
      { from: iso(CUR + P), intensity: 190, quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) },
    ]);
    const then = await (await client.fetch(`${G}/england/history?from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 90 * 60_000)}`)).json();
    expect(then.data.map((d: { intensity: number }) => d.intensity)).toEqual([205, 195]);
    const before = await (await client.fetch(`${G}/england/history?from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`)).json();
    expect(before).toMatchObject({ count: 0, data: [] }); // not yet forecast at that moment
    expect(store.calls).toEqual([]); // all from memory
  });

  it("history: reads older than the memory window go to the store, with the same semantics", async () => {
    const old = CUR - 10 * DAY;
    const res = await (await paying().fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`)).json();
    expect(res.data).toEqual([{ from: iso(old), intensity: 111, quality: "ok", known_at: iso(old - H), published_at: iso(old - H - 20_000) }]);
    expect(store.calls).toEqual(["asOf"]);
  });

  it("memory and store give identical answers for the same question", async () => {
    const history = new GridHistory(cache, store);
    for (const asOf of [undefined, T0 - 90 * 60_000, T0 - H, T0 - 3 * H]) {
      const mem = await history.history("wales", CUR - 2 * H, CUR + 48 * H, asOf);
      const db = await store.asOf({ dataset: DS, region: "wales", from: CUR - 2 * H, to: CUR + 48 * H, asOf });
      expect(mem.path).toBe("memory");
      expect(mem.rows).toEqual(db);
    }
  });

  it("revisions: every version of a period, oldest first", async () => {
    const res = await (await paying().fetch(`${G}/scotland/revisions?period=${iso(CUR + P)}`)).json();
    expect(res).toMatchObject({ country: "scotland", period: iso(CUR + P), count: 2 });
    expect(res.revisions).toEqual([
      { intensity: 25, quality: "ok", known_at: iso(T0 - 2 * H), published_at: iso(T0 - 2 * H - 20_000) },
      { intensity: 20, quality: "ok", known_at: iso(T0 - H), published_at: iso(T0 - H - 20_000) },
    ]);
    const unknown = await (await paying().fetch(`${G}/scotland/revisions?period=${iso(CUR + 100 * H)}`)).json();
    expect(unknown).toMatchObject({ count: 0, revisions: [] });
  });

  it.each([
    ["/england/history", 400],
    ["/england/history?from=2026-11-03", 400], // no time
    ["/england/history?from=2026-11-03T17:30:00", 400], // no zone
    [`/england/history?from=${iso(CUR)}&to=${iso(CUR)}`, 400],
    [`/england/history?from=${iso(CUR)}&to=${iso(CUR + 7 * DAY + 1)}`, 400],
    [`/england/history?from=${iso(CUR)}&as_of=${iso(T0 + 60_000)}`, 400], // future knowledge
    [`/england/history?from=${iso(CUR)}&as_of=yesterday`, 400],
    ["/england/revisions", 400],
    [`/england/revisions?period=${iso(CUR + 60_000)}`, 400], // not on a half-hour
    [`/atlantis/history?from=${iso(CUR)}`, 404],
  ])("%s is refused before any charge (%i)", async (path, status) => {
    const res = await paying().fetch(`${G}${path}`);
    expect(res.status).toBe(status);
    expect(await payments()).toEqual([]);
  });

  it("accepts zone offsets and a full 7-day range", async () => {
    const res = await paying().fetch(`${G}/england/history?from=2026-11-03T18:30:00%2B01:00&to=${iso(CUR + 7 * DAY)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].from).toBe(iso(CUR));
  });

  it("a store failure after charging is a 503 and the credits are refunded (I5)", async () => {
    const key = await creditsKey(1);
    store.down = true;
    const old = CUR - 10 * DAY;
    const res = await env.fetch(`${G}/england/history?from=${iso(old)}`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(await res.json()).toMatchObject({ error: "history_unavailable" });
    expect(await balance(key)).toBe(1);
  });

  it("goes stale (never charged) when ingest stops, and fresh again when it resumes", async () => {
    ingestAt = T0 - STORE_LIMITS.maxIngestAgeMs - 1;
    vi.setSystemTime(T0 + 46 * 60_000); // past GridFeed's 45-min fetch age
    await cache.refresh();
    await feed.poll();
    expect((await paying().fetch(`${G}/england/intensity`)).status).toBe(503);
    expect(await payments()).toEqual([]);
    ingestAt = Date.now();
    await feed.poll();
    expect((await paying().fetch(`${G}/england/intensity`)).status).toBe(200);
  });

  it("does not offer history without the version store", async () => {
    const plain = await createTestEnv({}, { products: [new GridProduct(feed)] });
    const countries = await (await plain.fetch(`${G}/countries`)).json();
    expect(countries.data[0].endpoints.map((e: { id: string }) => e.id)).not.toContain("grid.history");
    expect((await plain.fetch(`${G}/england/history?from=${iso(CUR)}`)).status).toBe(404);
  });

  it("reports the history cache on /status and /metrics", async () => {
    await paying().fetch(`${G}/england/history?from=${iso(CUR)}`);
    const status = await (await env.fetch(`${BASE_URL}/status`)).json();
    const grid = status.products.find((p: { id: string }) => p.id === "grid");
    expect(grid.history).toMatchObject({ cached_versions: 600, window_start: iso(T0 - 7 * DAY), reads: { memory: 1, store: 0 } });
    const m = await (await env.fetch(`${BASE_URL}/metrics`, ADMIN)).text();
    expect(m).toMatch(/grid_history_cache_versions 600/);
    expect(m).toMatch(/grid_history_reads\{path="memory"\} 1/);
  });
});
