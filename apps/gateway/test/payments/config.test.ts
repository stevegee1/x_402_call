import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import { bearerAuth, createFacilitatorClients } from "../../src/payments/facilitator-clients";

const PAY_TO = "0x00000000000000000000000000000000000000aa";
const TOKEN = "f".repeat(32);
const base = { PAY_TO, LOG_LEVEL: "silent" };
const prod = { ...base, NODE_ENV: "production", DATABASE_URL: "postgres://x", ADMIN_TOKEN: "a".repeat(32) };

describe("self-hosted facilitator config", () => {
  it("FACILITATOR=url requires a token in production", () => {
    expect(() => loadConfig({ ...prod, FACILITATOR: "url", FACILITATOR_URL: "http://f:8090" })).toThrow(/FACILITATOR_AUTH_TOKEN/);
    expect(() => loadConfig({ ...prod, FACILITATOR: "url", FACILITATOR_URL: "http://f:8090", FACILITATOR_AUTH_TOKEN: TOKEN })).not.toThrow();
  });

  it("a fallback facilitator requires a token in production", () => {
    const cdp = { FACILITATOR: "cdp", CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret", X402_NETWORK: "eip155:84532" };
    expect(() => loadConfig({ ...prod, ...cdp, FALLBACK_FACILITATOR_URL: "http://f:8090" })).toThrow(/FALLBACK_FACILITATOR_AUTH_TOKEN/);
    expect(() => loadConfig({ ...prod, ...cdp, FALLBACK_FACILITATOR_URL: "http://f:8090", FALLBACK_FACILITATOR_AUTH_TOKEN: TOKEN })).not.toThrow();
  });

  it("tokens are optional outside production", () => {
    expect(() => loadConfig({ ...base, FACILITATOR: "url", FACILITATOR_URL: "http://f:8090", FALLBACK_FACILITATOR_URL: "http://g:8090" })).not.toThrow();
  });

  it("rejects a short token", () => {
    expect(() => loadConfig({ ...base, FACILITATOR: "url", FACILITATOR_URL: "http://f:8090", FACILITATOR_AUTH_TOKEN: "short" })).toThrow(/FACILITATOR_AUTH_TOKEN/);
  });
});

describe("FX provider", () => {
  it("fixed FX is refused in production (crypto must be valued at spot)", () => {
    const cdp = { FACILITATOR: "cdp", CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" };
    expect(() => loadConfig({ ...prod, ...cdp, FX_PROVIDER: "fixed" })).toThrow(/FX_PROVIDER/);
    expect(loadConfig({ ...prod, ...cdp }).FX_PROVIDER).toBe("coinbase");
    expect(loadConfig({ ...base, FX_PROVIDER: "fixed" }).FX_PROVIDER).toBe("fixed");
  });
});

describe("facilitator clients", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bearerAuth is keyed by facilitator path (the shape HTTPFacilitatorClient requires)", async () => {
    const h = await bearerAuth(TOKEN)();
    for (const p of ["verify", "settle", "supported"] as const) expect(h[p]).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("sends the token to the primary and fallback self-hosted facilitators", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ kinds: [], extensions: [], signers: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cfg = loadConfig({
      ...base,
      FACILITATOR: "url",
      FACILITATOR_URL: "http://primary:8090",
      FACILITATOR_AUTH_TOKEN: TOKEN,
      FALLBACK_FACILITATOR_URL: "http://fallback:8090/",
      FALLBACK_FACILITATOR_AUTH_TOKEN: "g".repeat(32),
    });
    const { primary, fallback } = createFacilitatorClients(cfg);
    await primary.getSupported();
    await fallback!.getSupported();
    expect(seen).toEqual([
      { url: "http://primary:8090/supported", auth: `Bearer ${TOKEN}` },
      { url: "http://fallback:8090/supported", auth: `Bearer ${"g".repeat(32)}` },
    ]);
  });

  it("sends no Authorization header to x402.org, and no fallback unless configured", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return new Response(JSON.stringify({ kinds: [], extensions: [], signers: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { primary, fallback } = createFacilitatorClients(loadConfig({ ...base, FACILITATOR_AUTH_TOKEN: TOKEN }));
    await primary.getSupported();
    expect(seen).toEqual([null]);
    expect(fallback).toBeUndefined();
  });
});
