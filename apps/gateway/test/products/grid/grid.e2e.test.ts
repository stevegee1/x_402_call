import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridProduct } from "../../../src/products/grid";
import { GridFeed } from "../../../src/products/grid/feed";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, type TestEnv } from "../../helpers";
import { FakeSource, periods, T0 } from "./fixtures";

const ADMIN = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };

const policy = (): Policy => ({
  agentId: "grid-test",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
});
const G = `${BASE_URL}/v1/grid`;
const ATTRIBUTION = "Supported by National Energy SO Open Data";

describe("grid product end to end (in-process)", () => {
  let env: TestEnv;
  let source: FakeSource;
  let feed: GridFeed;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    source = new FakeSource(periods(-2, 48));
    feed = new GridFeed(source, { warn: () => {}, info: () => {} });
    await feed.poll();
    env = await createTestEnv({}, { products: [new GridProduct(feed)] });
  });
  afterEach(() => vi.useRealTimers());

  const paying = () => createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch });
  const payments = () => env.store.listPayments({ limit: 100 });

  it("is listed in the catalog with its prices, next to maritime", async () => {
    const products = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    expect(products.data.map((p: { id: string }) => p.id)).toEqual(["maritime", "grid"]);
    const countries = await (await env.fetch(`${G}/countries`)).json();
    expect(countries.data[0]).toMatchObject({ id: "england", fresh: true });
    expect(countries.data[0].endpoints.map((e: { price_usdc: string }) => e.price_usdc)).toEqual(["0.012", "0.022", "0.052"]);
    expect(countries.source.attribution).toBe(ATTRIBUTION);
  });

  it("challenges at the grid price and serves attributed data once paid; revenue books to revenue:grid", async () => {
    const challenge = await env.fetch(`${G}/england/window?duration_h=1`);
    expect(challenge.status).toBe(402);
    expect(decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!).accepts[0]!.amount).toBe("52000");

    const res = await paying().fetch(`${G}/england/window?duration_h=1&within_h=24`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ country: "england", unit: "gCO2/kWh", mode: "live", duration_h: 1, window: { mean_intensity: 115, saving_pct: 41 } });
    expect(body.source).toMatchObject({ licence: "NESO Open Data Licence", attribution: ATTRIBUTION });
    expect(body.source.disclaimer).toMatch(/not provided or endorsed by NESO/);

    await env.deps.settler.tick(new Date(Date.now() + 10_000));
    const [p] = await payments();
    expect(p).toMatchObject({ status: "settled", endpoint: "grid.window" });
    const accounts = (await env.store.journal()).flatMap((j) => j.lines.map((l) => l.account));
    expect(accounts).toContain("revenue:grid");
    expect(accounts).not.toContain("revenue:maritime");
  });

  it("intensity and forecast", async () => {
    const client = paying();
    const now = await (await client.fetch(`${G}/england/intensity`)).json();
    expect(now).toMatchObject({ intensity: 200, next: { intensity: 190 }, period: { from: "2026-11-03T17:30:00.000Z" } });
    const fc = await (await client.fetch(`${G}/wales/forecast?hours=6`)).json();
    expect(fc).toMatchObject({ country: "wales", hours: 6, count: 12 });
    expect(fc.data[0]).toEqual({ from: "2026-11-03T17:30:00.000Z", intensity: 300 });
  });

  it.each([
    ["/england/window", 400],
    ["/england/window?duration_h=0.25", 400],
    ["/england/window?duration_h=13", 400],
    ["/england/window?duration_h=2&within_h=1", 400],
    ["/england/window?duration_h=1.2", 400],
    ["/england/forecast?hours=0", 400],
    ["/england/forecast?hours=49", 400],
    ["/england/forecast?hours=2.5", 400],
    ["/atlantis/intensity", 404],
  ])("%s is refused before any charge (%i)", async (path, status) => {
    const res = await paying().fetch(`${G}${path}`);
    expect(res.status).toBe(status);
    expect(await payments()).toEqual([]);
  });

  it("a job that fits no contiguous stretch of the forecast is a 422, not charged", async () => {
    // Fresh (14 h ahead), but a missing half-hour at +6 h leaves no unbroken 12 h stretch.
    source.periods = periods(-2, 14, (i) => (i === 12 ? null : 100));
    await feed.poll();
    const res = await paying().fetch(`${G}/england/window?duration_h=12&within_h=48`);
    expect(res.status).toBe(422);
    expect(await payments()).toEqual([]);
  });

  it("I1: a frozen source turns into 503 'not charged' on both rails, and back once it advances", async () => {
    vi.setSystemTime(T0 + 3 * 3_600_000 + 60_000); // 3 h with no horizon advance
    await feed.poll();
    const x402 = await paying().fetch(`${G}/england/intensity`);
    expect(x402.status).toBe(503);
    expect((await x402.json()).detail).toMatch(/not been charged/);
    expect(await payments()).toEqual([]);

    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "DC Ltd", email: "a@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: 1, reference: "t1" }) });
    const credits = await env.fetch(`${G}/england/intensity`, { headers: { authorization: `Bearer ${signup.api_key}` } });
    expect(credits.status).toBe(503);
    expect((await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${signup.api_key}` } })).json()).balance_gbp).toBe(1);

    source.periods = periods(1, 51);
    await feed.poll();
    expect((await paying().fetch(`${G}/england/intensity`)).status).toBe(200);
  });

  it("an upstream outage never makes the gateway unready", async () => {
    source.failing = true;
    vi.setSystemTime(T0 + 60 * 60_000);
    await feed.poll();
    const ready = await (await env.fetch(`${BASE_URL}/readyz`)).json();
    expect(ready).toMatchObject({ ok: true, products: { maritime: true, grid: true } });
    const status = await (await env.fetch(`${BASE_URL}/status`)).json();
    const grid = status.products.find((p: { id: string }) => p.id === "grid");
    expect(grid.scopes[0]).toMatchObject({ scope: "england", fresh: false, reason: "fetch_stale" });
    expect(grid).toMatchObject({ consecutive_failures: 1, last_error: "NESO down" });
  });

  it("publishes freshness gauges", async () => {
    const m = await (await env.fetch(`${BASE_URL}/metrics`, ADMIN)).text();
    expect(m).toMatch(/grid_fresh\{country="england"\} 1/);
    expect(m).toMatch(/grid_horizon_hours\{country="england"\} 47\.8/);
  });
});
