import { EnvCache } from "@mx/env";
import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog, CatalogError } from "../../src/platform/catalog";
import type { PricedResource, Product } from "../../src/platform/product";
import { GridProduct } from "../../src/products/grid";
import { GridFeed } from "../../src/products/grid/feed";
import { GridHistory } from "../../src/products/grid/history";
import { StoreGridSource } from "../../src/products/grid/store-source";
import { GridUpdates } from "../../src/products/grid/updates";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";
import { T0 } from "../products/grid/fixtures";
import { FakeStore, storeRows } from "../products/grid/store-fixtures";

const STREAM = `${BASE_URL}/v1/grid/england/stream`;

/** Reads server-sent events from a streaming response as they arrive. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(timeoutMs = 2_000): Promise<{ event: string; data: unknown } | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), left))]);
        if (r === null) return null;
        if (r.done) return null;
        buf += dec.decode(r.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

describe("grid push over SSE, paid per event from an x402 session", () => {
  let env: TestEnv;
  let updates: GridUpdates;
  let feed: GridFeed;
  let ingestAt: number;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const store = new FakeStore(storeRows());
    const cache = new EnvCache(store, { dataset: "neso.carbon_intensity", regions: ["england", "scotland", "wales"], windowMs: 7 * 86_400_000 });
    await cache.refresh();
    ingestAt = T0;
    feed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => ingestAt }), { warn: () => {}, info: () => {} });
    await feed.poll();
    updates = new GridUpdates();
    env = await createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store), updates)], sessions: true });
  });
  afterEach(() => vi.useRealTimers());

  async function session(size = "usd1") {
    const client = createPolicyClient({
      policy: { agentId: "s", maxPricePerRequestUsd: 25, dailyBudgetUsd: 100, dailyBudgetGbp: 100, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: env.fetch,
    });
    const s = await (await client.fetch(`${BASE_URL}/v1/sessions/${size}`)).json();
    return { token: s.session_token as string, id: s.session_id as string };
  }
  const open = (token?: string) => env.fetch(STREAM, { headers: token ? { authorization: `Session ${token}` } : {} });
  const spent = async (id: string) => {
    await env.deps.sessions!.flush();
    return (await env.store.getSession(id))?.spentAtomic ?? 0n;
  };

  it("needs a session: 402 with where to buy one, nothing charged", async () => {
    const r = await open();
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "session_required", sessions: { sizes: `${BASE_URL}/v1/sessions/sizes` } });
    expect((await open("ses_forged")).status).toBe(401);
  });

  it("sends the forecast on connect and each new version after, charging each event", async () => {
    const { token, id } = await session();
    const res = await open(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = sse(res);
    const first = await events.next();
    expect(first).toMatchObject({ event: "forecast", data: { country: "england", current: { intensity: 200 } } });
    expect((first!.data as { forecast: unknown[] }).forecast.length).toBeGreaterThan(90);
    updates.publish();
    expect(await events.next()).toMatchObject({ event: "forecast" });
    expect(await spent(id)).toBe(24_000n); // two events at $0.012
    await events.cancel();
  });

  it("ends with session_ended once the balance is spent", async () => {
    const { token, id } = await session(); // $1: 83 events at $0.012, then $0.004 is left: less than one event
    const events = sse(await open(token));
    expect((await events.next())!.event).toBe("forecast");
    for (let i = 0; i < 82; i++) {
      updates.publish();
      expect((await events.next())!.event).toBe("forecast");
    }
    updates.publish();
    expect(await events.next()).toEqual({ event: "session_ended", data: { reason: "balance_spent" } });
    expect(await events.next(200)).toBeNull(); // closed
    expect(await spent(id)).toBe(996_000n);
    expect(updates.size).toBe(0);
  });

  it("an exhausted session is refused before the stream starts", async () => {
    const { token } = await session();
    for (let i = 0; i < 100; i++) await env.deps.sessions!.charge(token, "grid.stream", 10_000n);
    const r = await open(token);
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "session_exhausted" });
  });

  it("unsubscribes when the client leaves", async () => {
    const { token } = await session();
    const events = sse(await open(token));
    await events.next();
    expect(updates.size).toBe(1);
    await events.cancel();
    await vi.waitFor(() => expect(updates.size).toBe(0));
  });

  it("sends and charges nothing while the feed is stale", async () => {
    const { token, id } = await session();
    const events = sse(await open(token));
    await events.next();
    ingestAt = T0 - 21 * 60_000; // ingest has stopped
    vi.setSystemTime(T0 + 46 * 60_000);
    await feed.poll();
    updates.publish();
    expect(await events.next(200)).toBeNull();
    expect(await spent(id)).toBe(12_000n); // the connect event only
    await events.cancel();
  });

  it("refuses to open a stream on stale data at all", async () => {
    const { token, id } = await session();
    ingestAt = T0 - 21 * 60_000;
    vi.setSystemTime(T0 + 46 * 60_000);
    await feed.poll();
    expect((await open(token)).status).toBe(503);
    expect(await spent(id)).toBe(0n);
  });

  it("is listed with its per-event price and the session rail", async () => {
    const countries = await (await env.fetch(`${BASE_URL}/v1/grid/countries`)).json();
    const stream = countries.data[0].endpoints.find((e: { id: string }) => e.id === "grid.stream");
    expect(stream).toMatchObject({ price_usdc: "0.012" });
  });
});

describe("catalog rules for streams", () => {
  const product = (rails?: PricedResource["rails"]): Product<null> => ({
    id: "acme",
    displayName: "A",
    description: "A",
    resources: [{ id: "acme.live", path: "/live", summary: "s", pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 1 }, rails }],
    resolve: () => ({ scope: { scope: "x", fresh: true, mode: "live", sourceTs: null }, state: null }),
    routes: (r) => r.stream("acme.live", () => () => {}),
    status: () => ({ ready: true, scopes: [] }),
  });

  it("a stream must be paid from sessions only", () => {
    expect(() => new Catalog([product()])).toThrow(CatalogError);
    expect(() => new Catalog([product(["session", "x402"])])).toThrow(/rails \["session"\]/);
    expect(new Catalog([product(["session"])]).streams).toHaveLength(1);
  });

  it("rejects an empty or unknown rail list", () => {
    expect(() => new Catalog([product([])])).toThrow(/must not be empty/);
    expect(() => new Catalog([product(["bitcoin" as "x402"])])).toThrow(/unknown rail/);
  });
});
