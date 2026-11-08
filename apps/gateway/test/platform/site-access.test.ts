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

/** The full staging shape: maritime, grid from the version store (history + stream) and sessions. */
async function fullEnv(): Promise<TestEnv> {
  const store = new FakeStore(storeRows());
  const cache = new EnvCache(store, { dataset: "neso.carbon_intensity", regions: ["england", "scotland", "wales"], windowMs: 7 * 86_400_000 });
  await cache.refresh();
  const feed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => T0 }), { warn: () => {}, info: () => {} });
  await feed.poll();
  return createTestEnv({}, { products: [new GridProduct(feed, Date.now, new GridHistory(cache, store), new GridUpdates())], sessions: true });
}

describe("public site with sessions and streams", () => {
  let env: TestEnv;
  let html: string;
  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    env = await fullEnv();
    html = await (await env.fetch(`${BASE_URL}/`, { headers: { accept: BROWSER } })).text();
  });
  afterEach(() => vi.useRealTimers());

  const section = (id: string) => {
    const start = html.indexOf(`id="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf("<section", start + 1);
    return html.slice(start, end < 0 ? undefined : end);
  };

  it("presents sessions as a way to pay, never as a data feed with a credits price", () => {
    const card = html.slice(html.indexOf('id="sessions"'), html.indexOf("</article>", html.indexOf('id="sessions"')));
    expect(card).toContain("Way to pay");
    expect(card).not.toContain("Live data");
    expect(card).not.toContain("£");
    for (const size of ["$1", "$5", "$20"]) expect(card).toContain(`<b>${size}</b>`);
  });

  it("shows the stream per event with a dash for credits, since only a session can pay for it", () => {
    const row = /<tr><td><code>GET \/v1\/grid\/:country\/stream<\/code>[\s\S]*?<\/tr>/.exec(html)?.[0];
    expect(row).toBeDefined();
    expect(row).toContain("$0.01 / event");
    expect(row).toContain('title="Not payable with credits">—');
    expect(row).not.toMatch(/£\d/);
  });

  it("every other data endpoint still shows both prices", () => {
    const grid = env.deps.catalog.product("grid")!;
    for (const r of grid.resources.filter((x) => !x.rails)) {
      expect(html).toContain(`GET /v1/grid${r.path}`);
      expect(html).toContain(`£${(r.pricing.creditsGbpMicros / 1e6).toFixed(3)}`);
    }
  });

  it("explains every way to buy, with this server's real URLs", () => {
    const use = section("how-to-use");
    expect(use).toContain('role="tablist"');
    for (const tab of ["AI agent", "Trading platform", "Business (GBP)"]) expect(use).toContain(`>${tab}</button>`);
    expect(use).toContain(`${BASE_URL}/v1/sessions/usd1`);
    expect(use).toContain(`${BASE_URL}/v1/grid/england/stream`);
    expect(use).toContain("Authorization: Session $TOKEN");
    expect(use).toContain("as_of=");
  });

  it("tabs are wired for assistive tech: each tab controls a real panel labelled by it", () => {
    const tabs = [...html.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)" aria-selected="(true|false)"/g)];
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((t) => t[3] === "true")).toHaveLength(1);
    for (const [, tab, panel] of tabs) expect(html).toContain(`role="tabpanel" id="${panel}" aria-labelledby="${tab}"`);
  });

  it("all four explainer animations are present, labelled, and have unique ids", () => {
    for (const title of ["How an x402 payment flows", "Agents interacting with the gateway", "Maritime intelligence", "Intelligence for AI trading platforms"]) {
      expect(html).toContain(`>${title}</title>`);
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) for (const ref of m[1]!.split(" ")) expect(ids).toContain(ref);
  });

  it("uses no inline style attributes (the hash-only CSP would block them)", () => {
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("never hides content behind script: scenes animate in CSS, and only pause off screen", () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toContain("reveal");
    expect(css).toContain(".scene.paused *{animation-play-state:paused");
    expect(css).toContain("prefers-reduced-motion:reduce");
  });

  it("the NESO attribution is on the page", () => {
    expect(html).toContain("not provided or endorsed by NESO");
  });
});

describe("OpenAPI with sessions and streams", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("documents the stream, paid from a session only, and each endpoint's real payment options", async () => {
    const env = await fullEnv();
    const spec = await (await env.fetch(`${BASE_URL}/openapi.json`)).json();
    const stream = spec.paths["/v1/grid/{country}/stream"]?.get;
    expect(stream).toMatchObject({ operationId: "grid.stream", security: [{ session: [] }], "x-session": { price_usdc_per_event: "0.01" } });
    expect(stream.responses["200"].content).toHaveProperty("text/event-stream");
    expect(spec.components.securitySchemes.session).toMatchObject({ type: "apiKey", in: "header", name: "Authorization" });

    const buy = spec.paths["/v1/sessions/usd1"].get;
    expect(buy.security).toEqual([{}]); // x402 only: no credits, no session
    expect(buy).not.toHaveProperty("x-credits");
    expect(spec.paths["/v1/grid/{country}/intensity"].get.security).toEqual([{}, { credits: [] }, { session: [] }]);
  });
});
