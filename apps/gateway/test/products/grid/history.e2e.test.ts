import { EnvCache } from "@mx/env";
import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridProduct } from "../../../src/products/grid";
import { GridFeed } from "../../../src/products/grid/feed";
import { ASYNC_SETTLE_DELAY_MS } from "../../../src/payments/billing";
import { GATEWAY_ENV_POOL, GridHistory, SETTLE_MARGIN_MS, STORE_READ_DEADLINE_MS } from "../../../src/products/grid/history";
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

  it("says where each country's history starts, free, and describes what it sells", async () => {
    const countries = await (await env.fetch(`${G}/countries`)).json();
    expect(countries.data.map((c: { id: string; history_from: string }) => [c.id, c.history_from])).toEqual([
      ["england", iso(CUR - 10 * DAY)],
      ["scotland", iso(CUR - 10 * DAY)],
      ["wales", iso(CUR - 10 * DAY)],
    ]);
    const products = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    const grid = products.data.find((p: { id: string }) => p.id === "grid");
    expect(grid.description).toMatch(/Point-in-time history/);
    expect(grid.description).not.toMatch(/live push stream/); // no updates wired in this env
  });

  it("history_from never waits long on a hung store, and asks it once however many requests arrive", async () => {
    let release!: () => void;
    const s2 = new FakeStore(storeRows());
    s2.firstPeriodGate = new Promise<void>((r) => (release = r));
    const h2 = new GridHistory(cache, s2);
    const started = performance.now();
    const answers = await Promise.all([h2.historyFrom("england"), h2.historyFrom("england"), h2.historyFrom("england")]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(answers).toEqual([undefined, undefined, undefined]); // not known yet: "unknown", never "none"
    expect(s2.calls.filter((c) => c === "firstPeriod")).toHaveLength(1); // single flight
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h2.cachedHistoryFrom("england")).toBe(CUR - 10 * DAY); // the slow answer still lands in the cache
  });

  it("a hung store leaves no timer behind once each call has answered", async () => {
    const s4 = new FakeStore(storeRows());
    s4.firstPeriodGate = new Promise<void>(() => {}); // never answers
    const h4 = new GridHistory(cache, s4);
    const real = globalThis.setTimeout;
    let timers = 0;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => (timers++, real(fn, ms))) as typeof setTimeout;
    try {
      await Promise.all(Array.from({ length: 20 }, () => h4.historyFrom("england")));
      const afterCalls = timers;
      expect(afterCalls).toBe(21); // one budget timer per call, plus the single lookup's deadline
      await new Promise((r) => real(r, 1_200)); // several budgets later
      expect(timers).toBe(afterCalls); // nothing re-armed itself
    } finally {
      globalThis.setTimeout = real;
    }
    expect(s4.calls.filter((c) => c === "firstPeriod")).toHaveLength(1);
  });

  it("a refusal answers at once over HTTP when the store hangs, and says the start is unknown, not absent", async () => {
    const hung = new FakeStore(storeRows());
    hung.firstPeriodGate = new Promise<void>(() => {}); // boot warm-up and every lookup hang
    const c2 = new EnvCache(hung, { dataset: DS, regions: ["england", "scotland", "wales"], windowMs: 7 * DAY });
    await c2.refresh();
    const e2 = await createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(c2, hung))] });
    const client = createPolicyClient({
      policy: { agentId: "t", maxPricePerRequestUsd: 0.1, dailyBudgetUsd: 5, dailyBudgetGbp: 5, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: e2.fetch,
    });
    const started = performance.now();
    const res = await client.fetch(`${G}/england/history?from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`);
    const body = await res.json();
    expect(performance.now() - started).toBeLessThan(200); // no wait on the store (the budget alone is 250 ms)
    expect(res.status).toBe(404);
    expect(body.history_from).toBeNull();
    expect(body.detail).toMatch(/not known right now/);
    expect(body.detail).not.toMatch(/no history is recorded/);
    const t2 = performance.now();
    const rev = await client.fetch(`${G}/england/revisions?period=${iso(CUR + 100 * H)}`);
    expect(performance.now() - t2).toBeLessThan(200); // the revisions refusal doesn't wait either
    expect(rev.status).toBe(404);
    expect((await rev.json()).detail).toMatch(/not known right now/);
  });

  it("a refusal never waits on the store: it answers from the cache and refreshes in the background", async () => {
    const s3 = new FakeStore(storeRows());
    const h3 = new GridHistory(cache, s3);
    await h3.warm(["england"]);
    const lookups = () => s3.calls.filter((c) => c === "firstPeriod").length;
    expect(lookups()).toBe(1);
    let release!: () => void;
    s3.firstPeriodGate = new Promise<void>((r) => (release = r));
    expect(h3.cachedHistoryFrom("england")).toBe(CUR - 10 * DAY);
    expect(lookups()).toBe(1); // fresh: no refresh
    vi.setSystemTime(T0 + 11 * 60_000); // past the 10-min TTL
    expect(h3.cachedHistoryFrom("england")).toBe(CUR - 10 * DAY); // stale value, at once
    expect(lookups()).toBe(2); // and a background refresh started
    release();
  });

  it("re-checks a series with no history every 30 s, not every 10 min", async () => {
    const empty = new FakeStore([]);
    const h5 = new GridHistory(cache, empty);
    expect(await h5.historyFrom("england")).toBeNull(); // known: none
    const lookups = () => empty.calls.filter((c) => c === "firstPeriod").length;
    vi.setSystemTime(T0 + 29_000);
    await h5.historyFrom("england");
    expect(lookups()).toBe(1);
    vi.setSystemTime(T0 + 31_000);
    await h5.historyFrom("england");
    expect(lookups()).toBe(2);
  });

  it("a failed first lookup is 'unknown' on every path, never 'none'", async () => {
    const broken = new FakeStore(storeRows());
    broken.down = true;
    const h6 = new GridHistory(cache, broken);
    expect(await h6.historyFrom("england")).toBeUndefined();
    expect(await h6.historyFrom("england")).toBeUndefined(); // the cached failure too
    expect(h6.cachedHistoryFrom("england")).toBeUndefined();
  });

  it("abandons a hung lookup at its deadline, so callers stop piling on and the next request retries", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const hung = new FakeStore(storeRows());
    hung.firstPeriodGate = new Promise<void>(() => {});
    const h7 = new GridHistory(cache, hung);
    const first = h7.historyFrom("england");
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toBeUndefined(); // answered from the (empty) cache at the budget
    await vi.advanceTimersByTimeAsync(3_000); // the lookup's deadline passes: it settles as a failure
    await vi.advanceTimersByTimeAsync(30_000); // the unknown entry's retry window passes
    hung.firstPeriodGate = undefined; // the database is back
    const next = h7.historyFrom("england");
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toBe(CUR - 10 * DAY);
    expect(hung.calls.filter((c) => c === "firstPeriod")).toHaveLength(2); // retried, not stuck
  });

  it("history_from survives a store outage (last known value), and is cached", async () => {
    await env.fetch(`${G}/countries`);
    const probes = store.calls.filter((c) => c === "firstPeriod").length;
    await env.fetch(`${G}/countries`);
    expect(store.calls.filter((c) => c === "firstPeriod").length).toBe(probes); // cached
    store.down = true;
    vi.setSystemTime(T0 + 11 * 60_000); // past the cache TTL
    const res = await env.fetch(`${G}/countries`);
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].history_from).toBe(iso(CUR - 10 * DAY));
    // And for every request after it, not only the one that saw the failure.
    const again = await env.fetch(`${G}/countries`);
    expect((await again.json()).data[0].history_from).toBe(iso(CUR - 10 * DAY));
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
    expect(store.calls.filter((c) => c !== "firstPeriod")).toEqual([]); // all from memory (firstPeriod is the boot warm-up)
  });

  it("history: a range with nothing known at as_of is refused and not charged, and says where history starts", async () => {
    const OLD = CUR - 10 * DAY; // the earliest stored period (store-fixtures)
    const cases = [
      `from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`, // not yet forecast at that moment
      `from=${iso(OLD - 3 * DAY)}&to=${iso(OLD - DAY)}`, // before history begins
      `from=${iso(CUR + 60 * H)}&to=${iso(CUR + 70 * H)}`, // beyond any forecast
    ];
    for (const q of cases) {
      const res = await paying().fetch(`${G}/england/history?${q}`);
      expect(res.status, q).toBe(404);
      expect(await res.json()).toMatchObject({ error: "no_history", history_from: iso(OLD) });
    }
    // x402 (async, the default): every payment is cancelled because the handler refused, so the
    // settle worker never sees a verified row to charge.
    const rows = await payments();
    expect(rows).toHaveLength(cases.length);
    for (const r of rows) expect(r).toMatchObject({ status: "cancelled", error: "handler_status_404" });
  });

  it("history: in sync mode a refused read is cancelled before it ever settles", async () => {
    const sync = await createTestEnv({ SETTLEMENT_MODE: "sync" }, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store))] });
    const client = createPolicyClient({
      policy: { agentId: "t", maxPricePerRequestUsd: 0.1, dailyBudgetUsd: 5, dailyBudgetGbp: 5, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: sync.fetch,
    });
    const res = await client.fetch(`${G}/england/history?from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`);
    expect(res.status).toBe(404);
    const rows = await sync.store.listPayments({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "handler_status_404", settledAt: null });
  });

  it("history: a session read that finds nothing is refunded to the balance", async () => {
    const withSessions = await createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store))], sessions: true });
    const buyer = createPolicyClient({
      policy: { agentId: "s", maxPricePerRequestUsd: 25, dailyBudgetUsd: 100, dailyBudgetGbp: 100, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: withSessions.fetch,
    });
    const bought = await buyer.fetch(`${BASE_URL}/v1/sessions/usd1`);
    expect(bought.status).toBe(201);
    const token = ((await bought.json()) as { session_token: string }).session_token;
    const read = (q: string) => withSessions.fetch(`${G}/england/history?${q}`, { headers: { authorization: `Session ${token}` } });
    const ok = await read(`from=${iso(CUR)}&to=${iso(CUR + 2 * P)}`);
    expect(ok.status).toBe(200);
    const before = ok.headers.get("x-session-remaining-usdc-atomic");
    const refused = await read(`from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`);
    expect(refused.status).toBe(404);
    const after = await read(`from=${iso(CUR)}&to=${iso(CUR + 2 * P)}`);
    // The refused read cost nothing: the next paid read leaves exactly one more price taken.
    expect(BigInt(before!) - BigInt(after.headers.get("x-session-remaining-usdc-atomic")!)).toBe(52_000n);
  });

  it("history: a refused read refunds credits in full", async () => {
    const key = await creditsKey(1);
    const q = `from=${iso(CUR)}&to=${iso(CUR + 2 * P)}&as_of=${iso(T0 - 3 * H)}`;
    const res = await env.fetch(`${G}/england/history?${q}`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
    expect(await balance(key)).toBe(1);
  });

  it("history: reads older than the memory window go to the store, with the same semantics", async () => {
    const old = CUR - 10 * DAY;
    const res = await (await paying().fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`)).json();
    expect(res.data).toEqual([{ from: iso(old), intensity: 111, quality: "ok", known_at: iso(old - H), published_at: iso(old - H - 20_000) }]);
    expect(store.calls.filter((c) => c !== "firstPeriod")).toEqual(["asOf"]);
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
    const unknown = await paying().fetch(`${G}/scotland/revisions?period=${iso(CUR + 100 * H)}`);
    expect(unknown.status).toBe(404); // no version recorded: refused, not charged
    expect(await unknown.json()).toMatchObject({ error: "no_history", history_from: iso(CUR - 10 * DAY) });
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

  it("a slow database read ends as a 503 before an async payment could settle, and is cancelled", async () => {
    expect(STORE_READ_DEADLINE_MS).toBeLessThanOrEqual(ASYNC_SETTLE_DELAY_MS - 500); // a margin for the cancel itself
    store.readDelayMs = 2_500; // slower than the async settle delay
    const old = CUR - 10 * DAY; // outside the memory window: a store read
    const started = performance.now();
    const res = await paying().fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`);
    const took = performance.now() - started;
    expect(res.status).toBe(503);
    expect(took).toBeLessThan(ASYNC_SETTLE_DELAY_MS - 300); // answered well before the worker may settle
    const rows = await payments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "handler_status_503" }); // async is the test default
    const rev = await paying().fetch(`${G}/england/revisions?period=${iso(old)}`);
    expect(rev.status).toBe(503);
  });

  it("the gateway's pool settings keep every paid read's budget well inside the database timeouts", () => {
    expect(GATEWAY_ENV_POOL.max).toBeGreaterThanOrEqual(8);
    const { statementMs, queryMs, connectMs } = GATEWAY_ENV_POOL.timeouts;
    expect(STORE_READ_DEADLINE_MS).toBeLessThan(statementMs);
    expect(statementMs).toBeLessThan(queryMs); // the server cancels first on a live database; the client guard catches a dead one
    expect(connectMs).toBeGreaterThan(0);
  });

  it("the store-read budget ends before this payment's settle, however long admission took", () => {
    const h = new GridHistory(cache, store);
    const now = Date.now();
    expect(h.budget()).toBe(STORE_READ_DEADLINE_MS); // credits, sessions, sync x402: the plain deadline
    expect(h.budget(now + ASYNC_SETTLE_DELAY_MS)).toBe(STORE_READ_DEADLINE_MS); // fast admission
    expect(h.budget(now + 1_000)).toBe(1_000 - SETTLE_MARGIN_MS); // admission ate a second
    expect(h.budget(now + 300)).toBeLessThanOrEqual(0); // nothing left: answer 503 at once
  });

  it("billing hands the handler this payment's settle time: a slow admission leaves no time, so no query and no charge", async () => {
    const admit = env.store.admitPayment.bind(env.store);
    env.store.admitPayment = async (...args: Parameters<typeof admit>) => {
      const r = await admit(...args);
      vi.setSystemTime(Date.now() + 1_600); // admission took 1.6 s: the worker may settle 0.4 s from now
      return r;
    };
    const old = CUR - 10 * DAY; // a store read
    const res = await paying().fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`);
    expect(res.status).toBe(503);
    const rev = await paying().fetch(`${G}/england/revisions?period=${iso(old)}`);
    expect(rev.status).toBe(503);
    expect(store.calls.filter((c) => c === "asOf" || c === "revisions")).toEqual([]); // both refused before querying
    for (const row of await payments()) expect(row).toMatchObject({ status: "cancelled", error: "handler_status_503" });

    // The same slow admission on credits (no async settle) keeps the full budget and is served.
    const key = await creditsKey(1);
    const ok = await env.fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`, { headers: { authorization: `Bearer ${key}` } });
    expect(ok.status).toBe(200);
  });

  it("with no time left before the settle, a store read answers 503 at once and is cancelled", async () => {
    const h = new GridHistory(cache, store);
    const old = CUR - 10 * DAY;
    await expect(h.history("england", old, old + P, undefined, 0)).rejects.toThrow(/no time left/);
    await expect(h.revisions("england", old, -5)).rejects.toThrow(/no time left/);
    expect(h.storeTimeouts).toBe(2);
    expect(store.calls.filter((c) => c === "asOf" || c === "revisions")).toEqual([]); // never sent: no connection spent
  });

  it("counts store-read timeouts on /metrics", async () => {
    store.readDelayMs = 2_500;
    const old = CUR - 10 * DAY;
    await paying().fetch(`${G}/england/history?from=${iso(old)}&to=${iso(old + P)}`);
    const m = await (await env.fetch(`${BASE_URL}/metrics`, ADMIN)).text();
    expect(m).toMatch(/grid_history_store_timeouts 1/);
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

  it("does not offer or describe history without the version store", async () => {
    const plain = await createTestEnv({}, { products: [new GridProduct(feed)] });
    const countries = await (await plain.fetch(`${G}/countries`)).json();
    expect(countries.data[0].endpoints.map((e: { id: string }) => e.id)).not.toContain("grid.history");
    expect(countries.data[0]).not.toHaveProperty("history_from");
    expect(new GridProduct(feed).description).not.toMatch(/history/i);
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
