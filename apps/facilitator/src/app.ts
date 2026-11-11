import { timingSafeEqual } from "node:crypto";
import type { Metrics } from "@mx/shared";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { z } from "zod";
import type { ChainProbe } from "./chain";
import { NETWORK_CHAIN_IDS, type Config } from "./config";

/** The slice of x402Facilitator the HTTP layer uses; a seam for unit tests. */
export interface FacilitatorCore {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  getSupported(): ReturnType<x402Facilitator["getSupported"]>;
}

export interface FacilitatorDeps {
  cfg: Pick<Config, "NETWORK" | "AUTH_TOKEN" | "ALLOWED_PAY_TO" | "MIN_GAS_BALANCE_WEI">;
  core: FacilitatorCore;
  chain: ChainProbe;
  log: Logger;
  metrics: Metrics;
}

// Same body shape HTTPFacilitatorClient sends (@x402/core). Payload internals are validated by the scheme.
const requestSchema = z.object({
  x402Version: z.number().int(),
  paymentPayload: z.object({ x402Version: z.number().int() }).passthrough(),
  paymentRequirements: z.object({ scheme: z.string(), network: z.string(), payTo: z.string(), amount: z.string(), asset: z.string() }).passthrough(),
});

/**
 * Policy reasons. They contain "unsupported" so the gateway's settler classifies them as final
 * (retrying cannot change them).
 */
export const REASON_NETWORK = "unsupported_network";
export const REASON_PAY_TO = "unsupported_pay_to";

function bearer(token: string | undefined): MiddlewareHandler {
  const expected = token ? Buffer.from(token) : undefined;
  return async (c, next) => {
    if (!expected) return next(); // development only: config requires AUTH_TOKEN in production
    const got = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

/**
 * Self-hosted x402 facilitator: the gateway's fallback when the primary (Coinbase CDP) is down,
 * and the settlement path in the local e2e harness. Speaks the standard facilitator HTTP API:
 *   GET /supported   POST /verify   POST /settle
 * Business outcomes (invalid payment, failed settle) are 200 responses with isValid/success false,
 * which is what HTTPFacilitatorClient expects; 5xx means "outcome unknown" and the gateway then
 * reconciles against the chain.
 */
export function createApp(d: FacilitatorDeps) {
  const app = new Hono();
  const chainId = NETWORK_CHAIN_IDS[d.cfg.NETWORK];

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    try {
      const [id, gas] = await Promise.all([d.chain.chainId(), d.chain.gasBalanceWei()]);
      d.metrics.set("facilitator_gas_balance_wei", Number(gas));
      const checks = { chain: id === chainId, gas: gas >= d.cfg.MIN_GAS_BALANCE_WEI };
      const ready = checks.chain && checks.gas;
      return c.json({ ready, checks, signer: d.chain.address, gas_balance_wei: gas.toString() }, ready ? 200 : 503);
    } catch (e) {
      d.log.warn({ err: e }, "readiness check failed");
      return c.json({ ready: false, checks: { rpc: false } }, 503);
    }
  });

  app.get("/metrics", (c) => c.text(d.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" }));

  // Auth and size limit on the API routes only: probes and scrapes stay unauthenticated.
  const auth = bearer(d.cfg.AUTH_TOKEN);
  const limit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) });

  app.get("/supported", auth, async (c) => c.json(await d.core.getSupported()));

  const parse = async (raw: unknown) => {
    const r = requestSchema.safeParse(raw);
    if (!r.success) return null;
    return { payload: r.data.paymentPayload as unknown as PaymentPayload, requirements: r.data.paymentRequirements as unknown as PaymentRequirements };
  };

  /** Our own policy, checked before the scheme does any signature or chain work. */
  const policy = (req: PaymentRequirements): string | null => {
    if (req.network !== d.cfg.NETWORK) return REASON_NETWORK;
    if (!d.cfg.ALLOWED_PAY_TO.has(req.payTo.toLowerCase())) return REASON_PAY_TO;
    return null;
  };

  app.post("/verify", auth, limit, async (c) => {
    const body = await parse(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const refused = policy(body.requirements);
    if (refused) {
      d.metrics.inc("facilitator_verify_total", { result: refused });
      return c.json({ isValid: false, invalidReason: refused } satisfies VerifyResponse);
    }
    try {
      const res = await d.core.verify(body.payload, body.requirements);
      d.metrics.inc("facilitator_verify_total", { result: res.isValid ? "valid" : "invalid" });
      return c.json(res);
    } catch (e) {
      d.metrics.inc("facilitator_verify_total", { result: "error" });
      d.log.error({ err: e }, "verify failed");
      return c.json({ error: "verify_failed" }, 500);
    }
  });

  /**
   * The gas each settle really cost, from its receipt: what the price's network-fee allowance pays
   * for. Off the response path; a failed lookup costs a metric, never a settle.
   */
  const recordFee = async (tx: string) => {
    try {
      const { gasUsed, feeWei } = await d.chain.txFee(tx as `0x${string}`);
      const feeGwei = Number(feeWei) / 1e9;
      d.metrics.inc("facilitator_settle_gas_used_total", undefined, Number(gasUsed));
      d.metrics.inc("facilitator_settle_fee_gwei_total", undefined, feeGwei);
      d.metrics.inc("facilitator_settle_fee_recorded_total");
      d.metrics.set("facilitator_settle_fee_gwei_last", feeGwei);
      d.log.info({ tx, gas_used: gasUsed.toString(), fee_wei: feeWei.toString() }, "settle gas cost");
    } catch (e) {
      d.metrics.inc("facilitator_settle_fee_lookup_failed_total");
      d.log.warn({ err: e, tx }, "settle gas cost lookup failed");
    }
  };

  app.post("/settle", auth, limit, async (c) => {
    const body = await parse(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const refused = policy(body.requirements);
    if (refused) {
      d.metrics.inc("facilitator_settle_total", { result: refused });
      return c.json({ success: false, errorReason: refused, transaction: "", network: body.requirements.network } satisfies SettleResponse);
    }
    const t0 = Date.now();
    try {
      const res = await d.core.settle(body.payload, body.requirements);
      d.metrics.inc("facilitator_settle_total", { result: res.success ? "success" : "failed" });
      if (res.success) {
        d.log.info({ tx: res.transaction, payer: res.payer, ms: Date.now() - t0 }, "settled");
        void recordFee(res.transaction);
      } else d.log.warn({ reason: res.errorReason, payer: res.payer }, "settle rejected");
      return c.json(res);
    } catch (e) {
      // The transaction may or may not have been broadcast: report "unknown", never "failed".
      d.metrics.inc("facilitator_settle_total", { result: "error" });
      d.log.error({ err: e }, "settle failed with unknown outcome");
      return c.json({ error: "settle_outcome_unknown" }, 500);
    }
  });

  return app;
}
