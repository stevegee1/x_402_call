import { CREDIT_PACKS } from "@mx/shared";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../context";
import { looksLikeApiKey } from "../credits/keys";
import { CreditsError } from "../credits/service";
import { clientIp, WindowLimiter, type ClientIpHeader } from "./limits";

/** Per-IP limiter for unauthenticated account creation. */
function signupLimiter(source: ClientIpHeader, max: number, windowMs: number): MiddlewareHandler<AppEnv> {
  const limiter = new WindowLimiter(max, windowMs);
  return async (c, next) => {
    if (!limiter.hit(clientIp(c, source))) return c.json({ error: "rate_limited" }, 429);
    await next();
  };
}

export function creditsRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();

  const requireAccount: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!looksLikeApiKey(key)) return c.json({ error: "invalid_api_key" }, 401);
    const account = await d.credits.resolveKey(key);
    if (!account) return c.json({ error: "invalid_api_key" }, 401);
    c.set("account", account);
    await next();
  };

  r.onError((err, c) => {
    if (err instanceof CreditsError) return c.json({ error: err.code, detail: err.message }, err.status);
    throw err;
  });

  r.post("/v1/credits/accounts", signupLimiter(d.cfg.CLIENT_IP_HEADER, 10, 3_600_000), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { account, apiKey } = await d.credits.createAccount({ company: body.company, email: body.email, country: body.country, taxId: body.vat_number ?? body.tax_id ?? null });
    d.log.info({ accountId: account.id, country: account.country }, "credit account created");
    return c.json(
      {
        account_id: account.id,
        api_key: apiKey,
        note: "Store this key securely: it is shown once. Send it as 'Authorization: Bearer <key>'.",
        balance_gbp: 0,
        packs: Object.values(CREDIT_PACKS).map((p) => ({ id: p.id, label: p.label, net_gbp: p.netGbpMicros / 1e6 })),
      },
      201,
    );
  });

  r.get("/v1/credits/balance", requireAccount, (c) => {
    const a = c.get("account");
    return c.json({ account_id: a.id, company: a.company, balance_gbp: a.balanceMicros / 1e6, balance_gbp_micros: a.balanceMicros, status: a.status });
  });

  r.get("/v1/credits/usage", requireAccount, async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1_000);
    const rows = await d.store.usage(c.get("account").id, limit);
    return c.json({ data: rows.map((u) => ({ endpoint: u.endpoint, amount_gbp: u.micros / 1e6, at: u.at.toISOString() })) });
  });

  r.post("/v1/credits/checkout", requireAccount, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await d.credits.startCheckout(c.get("account"), String(body.pack ?? ""));
    return c.json({ checkout_url: session.url, session_id: session.id });
  });

  r.get("/v1/credits/checkout/success", (c) => c.text("Payment received. Credits are applied once Stripe confirms the payment (usually seconds)."));
  r.get("/v1/credits/checkout/cancelled", (c) => c.text("Checkout cancelled. No charge was made."));

  r.post("/v1/stripe/webhook", async (c) => {
    const sig = c.req.header("stripe-signature");
    if (!sig) return c.json({ error: "missing_signature" }, 400);
    const raw = await c.req.text(); // raw body required for signature verification
    try {
      const result = await d.credits.handleWebhook(raw, sig);
      if (result.applied) d.metrics.inc("credits_topups_total", { method: "stripe" });
      return c.json({ received: true, ...result });
    } catch (e) {
      if (e instanceof CreditsError) throw e;
      d.log.warn({ err: e }, "stripe webhook rejected");
      return c.json({ error: "invalid_webhook" }, 400);
    }
  });

  // Control-plane ingestion for the policy SDK (Product B). Authenticated by the customer's API key.
  r.post("/v1/policy/events", requireAccount, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    await d.store.addPolicyEvents(c.get("account").id, events);
    return c.json({ accepted: events.length });
  });

  return r;
}
