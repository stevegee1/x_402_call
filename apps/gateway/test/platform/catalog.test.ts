import { describe, expect, it } from "vitest";
import { revenueAccount } from "../../src/ledger/journal";
import { Catalog, CatalogError, productOfResource } from "../../src/platform/catalog";
import type { PricedResource, Product, ProductRoutes } from "../../src/platform/product";
import { MaritimeProduct } from "../../src/products/maritime";
import { MARITIME_RESOURCES } from "../../src/products/maritime/resources";
import { AcmeProduct } from "./fake-product";

type Reg = (r: ProductRoutes<unknown>) => void;

function product(over: { id?: string; resources?: PricedResource[]; routes?: Reg } = {}): Product {
  const resources = over.resources ?? [res()];
  return {
    id: over.id ?? "demo",
    displayName: "Demo",
    description: "demo",
    resources,
    resolve: () => new Response(null, { status: 404 }),
    routes: over.routes ?? ((r) => resources.forEach((x) => r.paid(x.id, () => new Response("ok")))),
    status: () => ({ ready: true, scopes: [] }),
  };
}

function res(over: Partial<PricedResource> = {}): PricedResource {
  return { id: "demo.thing", path: "/thing", summary: "A thing", pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 8_000 }, ...over };
}

const fails = (products: Product[], msg: RegExp) => expect(() => new Catalog(products)).toThrow(msg);

describe("Catalog validation (fails at boot, never on a paid request)", () => {
  it("accepts maritime and a second product together", () => {
    const c = new Catalog([new AcmeProduct(), product()]);
    expect(c.products.map((p) => p.id)).toEqual(["acme", "demo"]);
    expect(c.resources.map((r) => r.id)).toEqual(["acme.reading", "acme.report", "demo.thing"]);
    expect(c.paid.map((r) => r.path)).toEqual(["/v1/acme/:site/reading", "/v1/acme/:site/reports/:report", "/v1/demo/thing"]);
    expect(c.free.map((r) => r.path)).toEqual(["/v1/acme/sites"]);
    expect(c.admin.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /acme/reset"]);
    expect(c.resource("acme.reading")?.pricing.priceUsd).toBe("0.05");
    expect(c.product("demo")?.displayName).toBe("Demo");
    expect(c.product("nope")).toBeUndefined();
  });

  it("requires at least one product", () => fails([], /at least one product/));

  it.each(["", "a", "Maritime", "1abc", "has space", "under_score", "x".repeat(33)])("rejects product id %j", (id) => fails([product({ id, resources: [] })], /invalid product id/));

  it.each(["credits", "payments", "policy", "products", "stripe", "admin"])("rejects reserved product id %s", (id) =>
    fails([product({ id, resources: [] })], /reserved by the platform/),
  );

  it("rejects duplicate product ids", () => fails([product(), product()], /duplicate product id demo/));

  it("requires resource ids namespaced by their product", () => {
    fails([product({ resources: [res({ id: "other.thing" })] })], /must be demo\.<name>/);
    fails([product({ resources: [res({ id: "demo." })] })], /must be demo\.<name>/);
    fails([product({ resources: [res({ id: "demo.Bad Name" })] })], /must be demo\.<name>/);
  });

  it("rejects duplicate resource ids", () => fails([product({ resources: [res(), res({ path: "/other" })] })], /duplicate resource id demo\.thing/));

  it("validates prices on both rails", () => {
    fails([product({ resources: [res({ pricing: { kind: "fixed", priceUsd: "0.0000001", creditsGbpMicros: 1 } })] })], /≤ 6 decimals/);
    fails([product({ resources: [res({ pricing: { kind: "fixed", priceUsd: "-1", creditsGbpMicros: 1 } })] })], /≤ 6 decimals/);
    fails([product({ resources: [res({ pricing: { kind: "fixed", priceUsd: "0", creditsGbpMicros: 1 } })] })], /must be positive/);
    fails([product({ resources: [res({ pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 0 } })] })], /creditsGbpMicros/);
    fails([product({ resources: [res({ pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 1.5 } })] })], /creditsGbpMicros/);
    fails([product({ resources: [res({ pricing: { kind: "metered" } as never })] })], /unsupported pricing kind metered/);
  });

  it("requires path parameters to be declared, and declared ones to exist", () => {
    fails([product({ resources: [res({ path: "/:site/thing" })] })], /path parameter :site is not declared/);
    fails([product({ resources: [res({ parameters: [{ name: "site", in: "path", schema: {} }] })] })], /declared path parameter site is not in the path/);
    expect(() => new Catalog([product({ resources: [res({ path: "/:site/thing", parameters: [{ name: "site", in: "path", schema: {} }] })] })])).not.toThrow();
  });

  it("requires legacy aliases to be absolute and take the same parameters", () => {
    const p = [{ name: "site", in: "path" as const, schema: {} }];
    fails([product({ resources: [res({ path: "/:site/thing", parameters: p, legacyPaths: ["/thing"] })] })], /must be absolute under \/v1\//);
    fails([product({ resources: [res({ path: "/:site/thing", parameters: p, legacyPaths: ["/v1/thing"] })] })], /same parameters/);
  });

  it("requires exactly one handler per declared resource", () => {
    fails([product({ routes: () => {} })], /no handler for demo\.thing/);
    fails([product({ routes: (r) => (r.paid("demo.thing", () => new Response()), r.paid("demo.thing", () => new Response())) })], /two handlers/);
    fails([product({ routes: (r) => r.paid("demo.ghost", () => new Response()) })], /undeclared resource demo\.ghost/);
  });

  it("rejects two routes on the same path", () => {
    fails(
      [product({ routes: (r) => (r.paid("demo.thing", () => new Response()), r.free("/thing", () => new Response())) })],
      /route registered twice: GET \/v1\/demo\/thing/,
    );
    const a = product({ id: "one", resources: [res({ id: "one.x", legacyPaths: ["/v1/shared"] })] });
    const b = product({ id: "two", resources: [res({ id: "two.x", legacyPaths: ["/v1/shared"] })] });
    fails([a, b], /route registered twice: GET \/v1\/shared/);
  });
});

describe("maritime product definition", () => {
  it("keeps the published price list and stable resource ids", () => {
    expect(MARITIME_RESOURCES.map((r) => [r.id, r.pricing.priceUsd, r.pricing.creditsGbpMicros])).toEqual([
      ["maritime.vessels", "0.033", 25_000],
      ["maritime.vessel", "0.033", 25_000],
      ["maritime.density", "0.033", 25_000],
      ["maritime.queue", "0.066", 50_000],
      ["maritime.anomalies", "0.066", 50_000],
    ]);
  });

  it("passes catalog validation with every pre-platform path kept as an alias", () => {
    const m = new MaritimeProduct({ engine: {} as never, store: {} as never, feedConnected: () => true, snapshotIntervalMs: 250 });
    const c = new Catalog([m]);
    expect(c.paid.flatMap((r) => r.resource.legacyPaths ?? [])).toEqual([
      "/v1/:region/vessels",
      "/v1/:region/vessels/:mmsi",
      "/v1/:region/density",
      "/v1/:region/queue",
      "/v1/:region/anomalies",
    ]);
    expect(c.free.find((r) => r.path === "/v1/maritime/regions")?.legacyPaths).toEqual(["/v1/regions"]);
    expect(c.admin.map((r) => r.path)).toEqual(["/maritime/conditions/panama-draught"]);
  });
});

describe("revenue attribution", () => {
  it("derives the product from a namespaced resource id", () => {
    expect(productOfResource("maritime.vessels")).toBe("maritime");
    expect(productOfResource("dc-slough.capacity")).toBe("dc-slough");
    expect(revenueAccount("acme.reading")).toBe("revenue:acme");
  });

  it.each(["vessels", ".vessels", "maritime.", "Maritime.vessels", ""])("refuses to book revenue for malformed resource id %j", (id) => {
    expect(() => productOfResource(id)).toThrow(CatalogError);
    expect(() => revenueAccount(id)).toThrow(/invalid resource id/);
  });
});
