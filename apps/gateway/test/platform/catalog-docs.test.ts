import { EnvCache } from "@mx/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridProduct } from "../../src/products/grid";
import { GridFeed } from "../../src/products/grid/feed";
import { GridHistory } from "../../src/products/grid/history";
import { StoreGridSource } from "../../src/products/grid/store-source";
import { GridUpdates } from "../../src/products/grid/updates";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";
import { T0 } from "../products/grid/fixtures";
import { FakeStore, storeRows } from "../products/grid/store-fixtures";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** The staging shape: maritime, grid from the version store (history + stream) and sessions. */
async function fullEnv(): Promise<TestEnv> {
  const store = new FakeStore(storeRows());
  const cache = new EnvCache(store, { dataset: "neso.carbon_intensity", regions: ["england", "scotland", "wales"], windowMs: 7 * 86_400_000 });
  await cache.refresh();
  const feed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => T0 }), { warn: () => {}, info: () => {} });
  await feed.poll();
  return createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store), new GridUpdates())], sessions: true });
}

type Endpoint = { id: string; kind: string; path: string; url: string; example_url: string; docs: string; pay: { x402: unknown; credits: unknown; session: unknown } };
type Catalog = { data: { id: string; kind: string; coverage: { id: string }[]; endpoints: Endpoint[]; resources: { id: string; path: string; price_usdc: string }[] }[]; docs: Record<string, string> };

describe("catalog and API reference", () => {
  let env: TestEnv;
  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    env = await fullEnv();
  });
  afterEach(() => vi.useRealTimers());

  const get = (path: string, accept?: string) => env.fetch(`${BASE_URL}${path}`, { headers: accept ? { accept } : {}, redirect: "manual" });
  const catalog = async () => (await (await get("/v1/products")).json()) as Catalog;

  it("serves pages to browsers and JSON to everyone else, from the same URLs", async () => {
    for (const path of ["/v1/products", "/openapi.json"]) {
      const page = await get(path, BROWSER);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(page.headers.get("vary")).toMatch(/Accept/);
      for (const accept of [undefined, "*/*", "application/json"]) expect((await get(path, accept)).headers.get("content-type")).toMatch(/application\/json/);
      // The download links force JSON even in a browser.
      expect((await get(`${path}?format=json`, BROWSER)).headers.get("content-type")).toMatch(/application\/json/);
    }
    const one = await get("/v1/products/grid", BROWSER);
    expect(one.status).toBe(302);
    expect(one.headers.get("location")).toBe("/catalog#grid");
    expect((await get("/v1/products/nope", BROWSER)).status).toBe(404);
  });

  it("pages run no script and carry a strict policy", async () => {
    for (const path of ["/catalog", "/docs"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("script-src");
      expect(csp).toContain("frame-ancestors 'none'");
      const html = await res.text();
      expect(html).not.toMatch(/<script/);
      expect(html).not.toMatch(/\sstyle="/);
      expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
    }
  });

  it("keeps the original JSON fields, and adds a full description of every endpoint", async () => {
    const c = await catalog();
    expect(c.docs.api_reference).toBe(`${BASE_URL}/docs`);
    const grid = c.data.find((p) => p.id === "grid")!;
    expect(grid.kind).toBe("data");
    expect(grid.coverage.map((s) => s.id)).toEqual(["england", "scotland", "wales"]);
    // Original shape, unchanged for existing clients.
    expect(grid.resources.find((r) => r.id === "grid.intensity")).toMatchObject({ path: `${BASE_URL}/v1/grid/:country/intensity`, price_usdc: "0.01" });
    const intensity = grid.endpoints.find((e) => e.id === "grid.intensity")!;
    expect(intensity).toMatchObject({ kind: "paid", path: "/v1/grid/{country}/intensity", url: `${BASE_URL}/v1/grid/{country}/intensity`, docs: `${BASE_URL}/docs#grid.intensity` });
    expect(intensity.pay).toMatchObject({ x402: { price_usdc: "0.01" }, credits: { price_gbp: 0.008 }, session: { price_usdc: "0.01" } });
    const stream = grid.endpoints.find((e) => e.kind === "stream")!;
    expect(stream.pay).toMatchObject({ x402: null, credits: null });
    expect(grid.endpoints.find((e) => e.kind === "free")).toMatchObject({ path: "/v1/grid/countries", pay: { x402: null, credits: null, session: null } });
    // Sessions are a way to pay, not data: no coverage, and buying one isn't payable from a session.
    const sessions = c.data.find((p) => p.id === "sessions")!;
    expect(sessions).toMatchObject({ kind: "access", coverage: [] });
    expect(sessions.endpoints.filter((e) => e.kind === "paid").every((e) => e.pay.session === null)).toBe(true);
  });

  it("every example request is real: free ones answer, paid ones quote a price, none 400 or 404", async () => {
    const c = await catalog();
    for (const p of c.data)
      for (const e of p.endpoints) {
        if (e.kind === "stream") continue;
        const res = await get(e.example_url.slice(BASE_URL.length));
        if (e.kind === "free") expect(res.status, e.id).toBe(200);
        else expect(res.status, `${e.id} ${e.example_url}`).toBe(402);
      }
  });

  it("the spec and the pages describe exactly the endpoints the catalog lists", async () => {
    const c = await catalog();
    const spec = (await (await get("/openapi.json")).json()) as { paths: Record<string, { get: { summary: string; operationId: string; responses: Record<string, { content?: { "application/json": { schema: { $ref: string } } } }> } }>; components: { schemas: Record<string, unknown> } };
    const docs = await (await get("/docs")).text();
    const page = await (await get("/catalog")).text();
    for (const p of c.data)
      for (const e of p.endpoints) {
        expect(spec.paths[e.path], e.path).toBeDefined();
        expect(spec.paths[e.path]!.get.summary).not.toMatch(/^Free:/);
        expect(docs).toContain(`id="${e.id}"`);
        expect(page).toContain(`href="/docs#${e.id}"`);
      }
    // Every schema reference resolves.
    for (const op of Object.values(spec.paths))
      for (const r of Object.values(op.get.responses)) {
        const ref = r.content?.["application/json"]?.schema.$ref;
        if (ref) expect(spec.components.schemas[ref.split("/").pop()!], ref).toBeDefined();
      }
  });

  it("the catalog says honestly what's simulated and what's live", async () => {
    const page = await (await get("/catalog")).text();
    const maritime = page.slice(page.indexOf('id="maritime"'), page.indexOf('id="grid"'));
    expect(maritime).toContain("Simulated data"); // test env runs the maritime simulator
    expect(maritime).not.toContain("Live data");
    const grid = page.slice(page.indexOf('id="grid"'), page.indexOf('id="sessions"'));
    expect(grid).toMatch(/Live data|Data delayed/);
    expect(page).toContain("Not provided or endorsed by NESO");
  });
});
