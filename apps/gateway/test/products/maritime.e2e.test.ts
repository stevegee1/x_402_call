import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

const policy = (): Policy => ({
  agentId: "alias-test",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
});

describe("maritime: pre-platform paths stay served as deprecated aliases", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await createTestEnv();
  });

  it("challenges on the legacy path with Deprecation and a successor Link", async () => {
    const res = await env.fetch(`${BASE_URL}/v1/dover/vessels`);
    expect(res.status).toBe(402);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Link")).toBe(`<${BASE_URL}/v1/maritime/dover/vessels>; rel="successor-version"`);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.accepts[0]!.amount).toBe("35000");
    expect(pr.resource.url).toBe(`${BASE_URL}/v1/dover/vessels`); // the URL the buyer asked for, which it signs against
  });

  it("canonical paths carry no deprecation headers", async () => {
    const res = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(402);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
  });

  it("bills a legacy-path call as the same resource", async () => {
    const res = await createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch }).fetch(`${BASE_URL}/v1/dover/queue`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe("true");
    const [p] = await env.store.listPayments({ limit: 1 });
    expect(p).toMatchObject({ endpoint: "maritime.queue", amountAtomic: 68_000n });
  });

  it("fills every path parameter into the successor link", async () => {
    const mmsi = env.engine.get("rotterdam").vessels[0]!.mmsi;
    const res = await env.fetch(`${BASE_URL}/v1/rotterdam/vessels/${mmsi}`);
    expect(res.status).toBe(402);
    expect(res.headers.get("Link")).toBe(`<${BASE_URL}/v1/maritime/rotterdam/vessels/${mmsi}>; rel="successor-version"`);
  });

  it("serves the region list on both paths, advertising canonical endpoint paths", async () => {
    const canonical = await (await env.fetch(`${BASE_URL}/v1/maritime/regions`)).json();
    const legacy = await env.fetch(`${BASE_URL}/v1/regions`);
    expect(legacy.headers.get("Deprecation")).toBe("true");
    const body = await legacy.json();
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(canonical.data.map((r: { id: string }) => r.id));
    expect(body.data[0].endpoints.map((e: { id: string; path: string }) => [e.id, e.path])).toEqual([
      ["maritime.vessels", "/v1/maritime/dover/vessels"],
      ["maritime.vessel", "/v1/maritime/dover/vessels/:mmsi"],
      ["maritime.density", "/v1/maritime/dover/density"],
      ["maritime.queue", "/v1/maritime/dover/queue"],
      ["maritime.anomalies", "/v1/maritime/dover/anomalies"],
    ]);
  });

  it("unknown regions are a free 404 on both paths", async () => {
    for (const path of ["/v1/maritime/atlantis/vessels", "/v1/atlantis/vessels"]) {
      const res = await env.fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("unknown_region");
    }
  });

  it("aliases never shadow platform routes", async () => {
    expect((await env.fetch(`${BASE_URL}/v1/products`)).status).toBe(200);
    expect((await (await env.fetch(`${BASE_URL}/v1/payments/00000000-0000-0000-0000-000000000000`)).json()).error).toBe("not_found");
    const bal = await env.fetch(`${BASE_URL}/v1/credits/balance`);
    expect(bal.status).not.toBe(402);
    expect((await bal.json()).error).not.toBe("unknown_region");
  });
});
