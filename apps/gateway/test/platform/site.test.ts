import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { wantsHtml } from "../../src/routes/site";
import { BASE_URL, createTestEnv } from "../helpers";
import { AcmeProduct } from "./fake-product";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const page = async (overrides = {}, products = [new AcmeProduct()]) => {
  const env = await createTestEnv(overrides, { products });
  const res = await env.fetch(`${BASE_URL}/`, { headers: { accept: BROWSER } });
  return { env, res, html: await res.text() };
};
const sha = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

describe("public site", () => {
  it.each([
    [BROWSER, true],
    ["text/html", true],
    ["text/html, application/json", true],
    ["application/json, text/html", false],
    ["application/json", false],
    ["*/*", false],
    [undefined, false],
  ])("Accept %s -> html: %s", (accept, want) => {
    expect(wantsHtml(accept)).toBe(want);
  });

  it("browsers get the page; agents and curl keep the same JSON at /", async () => {
    const { env, res, html } = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toMatch(/^<!doctype html>/);
    const clients: Record<string, string>[] = [{}, { accept: "*/*" }, { accept: "application/json" }];
    for (const headers of clients) {
      const api = await env.fetch(`${BASE_URL}/`, { headers });
      expect(api.headers.get("content-type")).toContain("application/json");
      expect(api.headers.get("vary")).toBe("Accept");
      expect((await api.json()).service).toBe("x402 data gateway");
    }
  });

  it("shows every resource at its catalog price, in both currencies", async () => {
    const { env, html } = await page();
    for (const p of env.deps.catalog.products) {
      for (const r of p.resources) {
        expect(html).toContain(`GET /v1/${p.id}${r.path}`);
        expect(html).toContain(`$${r.pricing.priceUsd}`);
        expect(html).toContain(`£${(r.pricing.creditsGbpMicros / 1e6).toFixed(3)}`);
      }
    }
  });

  it("says when data is simulated or delayed, and never calls it live", async () => {
    const acme = new AcmeProduct();
    const { env, html } = await page({}, [acme]);
    // Maritime test data is simulated.
    const maritime = html.slice(html.indexOf(">Maritime<"), html.indexOf(">Acme Telemetry<"));
    expect(maritime).toContain("Simulated data");
    expect(maritime).not.toContain("Live data");
    acme.fresh = false;
    const stale = await (await env.fetch(`${BASE_URL}/`, { headers: { accept: BROWSER } })).text();
    expect(stale.slice(stale.indexOf(">Acme Telemetry<"))).toContain("Data delayed");
  });

  it("the test environment is labelled and not indexed; mainnet is neither", async () => {
    const { res, html } = await page();
    expect(html).toContain("Test environment");
    expect(html).toContain("Base Sepolia");
    expect(html).toContain('name="robots" content="noindex"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex");

    const main = await page({ X402_NETWORK: "eip155:8453" });
    expect(main.html).not.toContain("Test environment");
    expect(main.html).not.toContain("noindex");
    expect(main.res.headers.get("x-robots-tag")).toBeNull();
  });

  it("CSP allows exactly the inline style and script on the page, and nothing else", async () => {
    const { res, html } = await page();
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`style-src '${sha(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!)}'`);
    expect(csp).toContain(`script-src '${sha(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!)}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("loads nothing from third parties", async () => {
    const { html } = await page();
    expect(html.match(/<(?:script|link|img)[^>]+(?:src|href)="https?:[^"]*"/g)).toBeNull();
    expect(html).not.toMatch(/fonts\.googleapis|gtag|analytics/);
  });

  it("escapes catalog text", async () => {
    const evil = Object.assign(new AcmeProduct(), { displayName: '<img src=x onerror="alert(1)">', description: "</p><script>alert(2)</script>" });
    const { html } = await page({}, [evil]);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x");
  });

  it("every Try button targets a resource that returns a real 402 without charging", async () => {
    const { env, html } = await page();
    const paths = [...html.matchAll(/data-try="([^"]+)"/g)].map((m) => m[1]!);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      const res = await env.fetch(`${BASE_URL}${p}`, { headers: { accept: "application/json" } });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(Number(body.accepts[0].amount)).toBeGreaterThan(0);
    }
    expect(await env.store.listPayments({ limit: 10 })).toEqual([]);
  });

  it("doesn't expose the operator console or any secret", async () => {
    const { env, html } = await page();
    expect(html).not.toContain("/console");
    expect(html).not.toContain(env.deps.cfg.ADMIN_TOKEN!);
  });
});
