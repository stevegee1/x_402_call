import { Metrics } from "@mx/shared";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, REASON_NETWORK, REASON_PAY_TO, type FacilitatorCore } from "../src/app";
import type { ChainProbe } from "../src/chain";
import { loadConfig } from "../src/config";

const PAY_TO = "0x00000000000000000000000000000000000000aa";
const TOKEN = "t".repeat(32);

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: "33000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", version: "2" },
  ...over,
});
const body = (reqOver: Record<string, unknown> = {}) => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, payload: { signature: "0x", authorization: {} }, accepted: requirements(reqOver) },
  paymentRequirements: requirements(reqOver),
});

function setup(opts: { token?: string; chainId?: number; gas?: bigint; probeFails?: boolean } = {}) {
  const core = {
    verify: vi.fn<FacilitatorCore["verify"]>(async () => ({ isValid: true, payer: "0xpayer" })),
    settle: vi.fn<FacilitatorCore["settle"]>(async () => ({ success: true, transaction: "0xtx", network: "eip155:84532", payer: "0xpayer" })),
    getSupported: vi.fn(() => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: { "eip155:*": ["0xsigner"] } })),
  };
  const chain: ChainProbe = {
    address: "0x0000000000000000000000000000000000000001",
    chainId: async () => {
      if (opts.probeFails) throw new Error("rpc down");
      return opts.chainId ?? 84532;
    },
    gasBalanceWei: async () => opts.gas ?? 10n ** 18n,
  };
  const metrics = new Metrics();
  const app = createApp({
    cfg: { NETWORK: "eip155:84532", AUTH_TOKEN: "token" in opts ? opts.token : TOKEN, ALLOWED_PAY_TO: new Set([PAY_TO]), MIN_GAS_BALANCE_WEI: 10n ** 15n },
    core,
    chain,
    log: pino({ level: "silent" }),
    metrics,
  });
  const call = (method: string, path: string, json?: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { app, core, metrics, call };
}

describe("facilitator HTTP API", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  describe("auth", () => {
    it.each([
      ["GET", "/supported"],
      ["POST", "/verify"],
      ["POST", "/settle"],
    ])("%s %s rejects a missing or wrong token", async (method, path) => {
      for (const headers of [{} as Record<string, string>, { authorization: "Bearer nope" }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN.slice(1) }]) {
        const res = await t.call(method, path, method === "POST" ? body() : undefined, headers);
        expect(res.status).toBe(401);
      }
      expect(t.core.settle).not.toHaveBeenCalled();
      expect(t.core.verify).not.toHaveBeenCalled();
    });

    it("probes and metrics need no token", async () => {
      for (const p of ["/healthz", "/readyz", "/metrics"]) expect((await t.call("GET", p, undefined, {})).status).toBe(200);
    });

    it("without AUTH_TOKEN (development) the API is open", async () => {
      const open = setup({ token: undefined });
      expect((await open.call("POST", "/verify", body(), {})).status).toBe(200);
    });
  });

  describe("/supported", () => {
    it("returns the core's supported kinds", async () => {
      const res = await t.call("GET", "/supported");
      expect(await res.json()).toMatchObject({ kinds: [{ scheme: "exact", network: "eip155:84532" }] });
    });
  });

  describe("/verify", () => {
    it("passes a well-formed request to the scheme", async () => {
      const res = await t.call("POST", "/verify", body());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isValid: true, payer: "0xpayer" });
      expect(t.core.verify).toHaveBeenCalledWith(body().paymentPayload, body().paymentRequirements);
      expect(t.metrics.get("facilitator_verify_total", { result: "valid" })).toBe(1);
    });

    it("an invalid payment is a 200 with isValid=false (the client's contract)", async () => {
      t.core.verify.mockResolvedValueOnce({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
      const res = await t.call("POST", "/verify", body());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isValid: false });
    });

    it("refuses a payTo outside the allowlist without touching the scheme", async () => {
      const res = await t.call("POST", "/verify", body({ payTo: "0x00000000000000000000000000000000000000bb" }));
      expect(await res.json()).toEqual({ isValid: false, invalidReason: REASON_PAY_TO });
      expect(t.core.verify).not.toHaveBeenCalled();
    });

    it("allowlist matching ignores address case", async () => {
      const res = await t.call("POST", "/verify", body({ payTo: PAY_TO.toUpperCase().replace("0X", "0x") }));
      expect(await res.json()).toMatchObject({ isValid: true });
    });

    it("refuses another network", async () => {
      const res = await t.call("POST", "/verify", body({ network: "eip155:8453" }));
      expect(await res.json()).toEqual({ isValid: false, invalidReason: REASON_NETWORK });
      expect(t.core.verify).not.toHaveBeenCalled();
    });

    it.each([
      ["not json", "{"],
      ["missing requirements", JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2 } })],
      ["payTo missing", JSON.stringify({ ...body(), paymentRequirements: { ...requirements(), payTo: undefined } })],
    ])("400 on a malformed body (%s)", async (_, raw) => {
      const res = await t.app.request("/verify", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: raw });
      expect(res.status).toBe(400);
    });

    it("413 on an oversized body", async () => {
      const res = await t.call("POST", "/verify", { ...body(), junk: "x".repeat(70 * 1024) });
      expect(res.status).toBe(413);
    });

    it("a scheme exception is a 500 (so the gateway fails over)", async () => {
      t.core.verify.mockRejectedValueOnce(new Error("rpc timeout"));
      expect((await t.call("POST", "/verify", body())).status).toBe(500);
      expect(t.metrics.get("facilitator_verify_total", { result: "error" })).toBe(1);
    });
  });

  describe("/settle", () => {
    it("settles and returns the transaction", async () => {
      const res = await t.call("POST", "/settle", body());
      expect(await res.json()).toMatchObject({ success: true, transaction: "0xtx" });
      expect(t.metrics.get("facilitator_settle_total", { result: "success" })).toBe(1);
    });

    it("refuses a disallowed payTo as a final, well-formed SettleResponse", async () => {
      const res = await t.call("POST", "/settle", body({ payTo: "0x00000000000000000000000000000000000000bb" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: false, errorReason: REASON_PAY_TO, transaction: "", network: "eip155:84532" });
      expect(t.core.settle).not.toHaveBeenCalled();
    });

    it("policy reasons are classified final by the gateway settler", () => {
      // Mirrors FINAL_REASON in apps/gateway/src/payments/settlement.ts: a retry cannot fix these.
      const FINAL_REASON = /insufficient|invalid|signature|expired|value|recipient|unsupported/i;
      expect(FINAL_REASON.test(REASON_PAY_TO)).toBe(true);
      expect(FINAL_REASON.test(REASON_NETWORK)).toBe(true);
    });

    it("a rejected settle is a 200 with success=false", async () => {
      t.core.settle.mockResolvedValueOnce({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
      const res = await t.call("POST", "/settle", body());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    });

    it("an exception is a 500 'outcome unknown', never a reported failure", async () => {
      t.core.settle.mockRejectedValueOnce(new Error("receipt timeout"));
      const res = await t.call("POST", "/settle", body());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "settle_outcome_unknown" });
    });
  });

  describe("/readyz", () => {
    it("ready with the right chain and enough gas", async () => {
      const res = await t.call("GET", "/readyz");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ready: true, checks: { chain: true, gas: true } });
      expect(t.metrics.get("facilitator_gas_balance_wei")).toBe(1e18);
    });

    it("not ready when gas is below the floor", async () => {
      const res = await setup({ gas: 10n ** 15n - 1n }).call("GET", "/readyz");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ready: false, checks: { gas: false } });
    });

    it("not ready on a chain id mismatch", async () => {
      const res = await setup({ chainId: 8453 }).call("GET", "/readyz");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ checks: { chain: false } });
    });

    it("not ready when the RPC is down", async () => {
      expect((await setup({ probeFails: true }).call("GET", "/readyz")).status).toBe(503);
    });
  });
});

describe("config", () => {
  const base = {
    RPC_URL: "http://127.0.0.1:8545",
    FACILITATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    ALLOWED_PAY_TO: `${PAY_TO}, 0x00000000000000000000000000000000000000BB`,
  };

  it("parses the allowlist into lower-case addresses", () => {
    const c = loadConfig(base);
    expect([...c.ALLOWED_PAY_TO]).toEqual([PAY_TO, "0x00000000000000000000000000000000000000bb"]);
    expect(c.NETWORK).toBe("eip155:84532");
    expect(c.MIN_GAS_BALANCE_WEI).toBe(10n ** 15n);
  });

  it("requires AUTH_TOKEN in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/AUTH_TOKEN: required in production/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_TOKEN: TOKEN })).not.toThrow();
  });

  it.each([
    ["empty allowlist", { ALLOWED_PAY_TO: " , " }, /ALLOWED_PAY_TO/],
    ["bad address", { ALLOWED_PAY_TO: "0x1234" }, /ALLOWED_PAY_TO/],
    ["bad key", { FACILITATOR_PRIVATE_KEY: "0x1234" }, /FACILITATOR_PRIVATE_KEY/],
    ["short token", { AUTH_TOKEN: "short" }, /AUTH_TOKEN/],
    ["unknown network", { NETWORK: "eip155:1" }, /NETWORK/],
  ])("rejects %s", (_, over, err) => {
    expect(() => loadConfig({ ...base, ...over })).toThrow(err);
  });

  it("never echoes the private key in a config error", () => {
    const key = `0x${"ab".repeat(31)}`; // one byte short
    try {
      loadConfig({ ...base, FACILITATOR_PRIVATE_KEY: key });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(key.slice(2));
    }
  });
});
