import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, PAY_TO } from "../helpers";

const METRICS_TOKEN = "scrape-token-0123456789abcdef0123";
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe("/metrics access", () => {
  it("is refused without the admin token: it carries revenue, exposure and payer counts", async () => {
    const env = await createTestEnv();
    for (const init of [undefined, bearer(""), bearer("wrong"), bearer(ADMIN_TOKEN.slice(0, -1)), bearer(ADMIN_TOKEN + "x"), { headers: { authorization: `Basic ${ADMIN_TOKEN}` } }, { headers: { "x-admin-token": ADMIN_TOKEN } }]) {
      const res = await env.fetch(`${BASE_URL}/metrics`, init);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toMatch(/x402_exposure|revenue/);
    }
    const ok = await env.fetch(`${BASE_URL}/metrics`, bearer(ADMIN_TOKEN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/^x402_exposure_usdc_atomic 0$/m);
  });

  it("uses METRICS_TOKEN instead of the admin token when one is set", async () => {
    const env = await createTestEnv({ METRICS_TOKEN });
    expect((await env.fetch(`${BASE_URL}/metrics`, bearer(METRICS_TOKEN))).status).toBe(200);
    // The scraper's credential is separate: the admin token no longer opens metrics...
    expect((await env.fetch(`${BASE_URL}/metrics`, bearer(ADMIN_TOKEN))).status).toBe(401);
    // ...and the scraper's token never opens the admin API.
    expect((await env.fetch(`${BASE_URL}/admin/summary`, bearer(METRICS_TOKEN))).status).toBe(401);
  });

  it("leaves health and status public (Railway's health check and buyers read them)", async () => {
    const env = await createTestEnv();
    for (const p of ["/healthz", "/readyz", "/status"]) expect((await env.fetch(`${BASE_URL}${p}`)).status).toBe(200);
  });

  it("is open only when no token exists at all, which production config refuses", async () => {
    const env = await createTestEnv({ ADMIN_TOKEN: undefined as unknown as string });
    expect((await env.fetch(`${BASE_URL}/metrics`)).status).toBe(200);
    expect(() => loadConfig({ NODE_ENV: "production", PAY_TO, PUBLIC_BASE_URL: BASE_URL, DATABASE_URL: "postgres://x@y/z", FACILITATOR: "x402org" })).toThrow(/ADMIN_TOKEN/);
  });

  it("rejects a short METRICS_TOKEN", () => {
    expect(() => loadConfig({ NODE_ENV: "test", PAY_TO, PUBLIC_BASE_URL: BASE_URL, METRICS_TOKEN: "short" })).toThrow(/METRICS_TOKEN/);
  });
});
