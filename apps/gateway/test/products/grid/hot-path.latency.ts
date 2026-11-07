import { EnvCache } from "@mx/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GridProduct } from "../../../src/products/grid";
import { GridFeed } from "../../../src/products/grid/feed";
import { GridHistory } from "../../../src/products/grid/history";
import { StoreGridSource } from "../../../src/products/grid/store-source";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, type TestEnv } from "../../helpers";
import { CUR, T0 } from "./fixtures";
import { FakeStore, storeRows } from "./store-fixtures";
import { x402SettlementJournal } from "../../../src/ledger/journal";
import { newPayment } from "../../store/fixtures";

/**
 * Latency budgets for the environmental hot path (architecture.md §6.4), measured through the whole
 * gateway in-process: routing, billing on the credits rail, the product handler and JSON. The
 * network and the database are out of the loop by design: these reads must not touch either.
 *
 * Budgets are p99 on a shared CI runner. A local run is far below them. Failing one means the hot
 * path started doing I/O or something quadratic, which is exactly what this test exists to catch.
 */
const BUDGET_P99_MS = 5;
const N = 400;
const G = `${BASE_URL}/v1/grid`;
const iso = (t: number) => new Date(t).toISOString();

function p(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

describe("hot-path latency budgets (in-process, credits and session rails)", () => {
  let env: TestEnv;
  let key: string;
  let sessionToken: string;
  let store: FakeStore;

  beforeAll(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    store = new FakeStore(storeRows());
    const cache = new EnvCache(store, { dataset: "neso.carbon_intensity", regions: ["england", "scotland", "wales"], windowMs: 7 * 86_400_000 });
    await cache.refresh();
    const feed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => T0 }), { warn: () => {}, info: () => {} });
    await feed.poll();
    env = await createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store))], sessions: { leaseAtomic: 5_000_000n } });
    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Quant Ltd", email: "q@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: 500, reference: "t" }) });
    key = signup.api_key;
    // A large settled session ($1 000), straight into the store: the purchase path is tested elsewhere.
    const p = newPayment({ endpoint: "sessions.usd20", amountAtomic: 1_000_000_000n, fxRate: 0.8 });
    await env.store.insertPayment(p);
    await env.store.settlePayment(p.id, "0xtx", x402SettlementJournal({ paymentId: p.id, amountAtomic: p.amountAtomic, fxRate: 0.8, fxSource: "fixed:test", transaction: "0xtx", payer: p.payer, network: p.network, endpoint: p.endpoint, occurredAt: new Date().toISOString() }));
    sessionToken = env.deps.sessions!.tokens.issue(p.id);
  });
  afterAll(() => vi.useRealTimers());

  async function measure(path: string, rail: "credits" | "session" = "credits"): Promise<{ p50: number; p99: number }> {
    const headers = { authorization: rail === "credits" ? `Bearer ${key}` : `Session ${sessionToken}` };
    for (let i = 0; i < 50; i++) expect((await env.fetch(`${G}${path}`, { headers })).status).toBe(200); // warm up the JIT
    const t: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const res = await env.fetch(`${G}${path}`, { headers });
      await res.arrayBuffer();
      t.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
    }
    return { p50: p(t, 0.5), p99: p(t, 0.99) };
  }

  it.each([
    ["live: intensity now", "/england/intensity"],
    ["live: 48 h forecast", "/england/forecast?hours=48"],
    ["history: latest, 50 h", `/england/history?from=${iso(CUR - 2 * 3_600_000)}&to=${iso(CUR + 48 * 3_600_000)}`],
    ["history: as of 90 min ago, 50 h", `/england/history?from=${iso(CUR - 2 * 3_600_000)}&to=${iso(CUR + 48 * 3_600_000)}&as_of=${iso(T0 - 90 * 60_000)}`],
    ["revisions of one period", `/england/revisions?period=${iso(CUR)}`],
  ])(`%s: p99 under ${BUDGET_P99_MS} ms, never touching the store`, async (name, path) => {
    const calls = store.calls.length;
    // Best of three rounds: a scheduling spike on a shared runner hits one round; a regression in
    // the code hits all three.
    const rounds = [await measure(path), await measure(path), await measure(path)];
    const r = rounds.reduce((a, b) => (b.p99 < a.p99 ? b : a));
    if (process.env.LATENCY_REPORT) console.log(`${name}: p50 ${r.p50.toFixed(3)} ms, p99 ${r.p99.toFixed(3)} ms`);
    expect(store.calls.length).toBe(calls); // memory only
    expect(r.p99).toBeLessThan(BUDGET_P99_MS);
  });

  it.each([
    ["session: intensity now", "/england/intensity"],
    ["session: history as of 90 min ago, 50 h", `/england/history?from=${iso(CUR - 2 * 3_600_000)}&to=${iso(CUR + 48 * 3_600_000)}&as_of=${iso(T0 - 90 * 60_000)}`],
  ])(`%s: p99 under ${BUDGET_P99_MS} ms with no store, chain or facilitator on the path`, async (name, path) => {
    const rounds = [await measure(path, "session"), await measure(path, "session"), await measure(path, "session")];
    const r = rounds.reduce((a, b) => (b.p99 < a.p99 ? b : a));
    if (process.env.LATENCY_REPORT) console.log(`${name}: p50 ${r.p50.toFixed(3)} ms, p99 ${r.p99.toFixed(3)} ms`);
    expect(await env.store.listPayments({ limit: 5 })).toHaveLength(1); // only the session purchase
    expect(r.p99).toBeLessThan(BUDGET_P99_MS);
  });
});
