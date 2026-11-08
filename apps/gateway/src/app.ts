import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./context";
import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { productRoutes } from "./platform/mount";
import { creditsRoutes } from "./routes/credits";
import { publicRoutes } from "./routes/public";
import { walletRoutes } from "./routes/wallet";

export function createApp(d: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const id = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", id);
    const t0 = performance.now();
    await next();
    c.res.headers.set("x-request-id", id);
    c.res.headers.set("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Payment-Id, X-Settlement, X-Credits-Charged-Gbp-Micros, X-Credits-Balance-Gbp-Micros, X-Agent-Tier, X-Session-Charged-Usdc-Atomic, X-Session-Remaining-Usdc-Atomic, Deprecation, Link");
    const ms = performance.now() - t0;
    d.metrics.inc("http_requests_total", { status: String(c.res.status) });
    if (ms > 500) d.log.warn({ path: c.req.path, status: c.res.status, ms: Math.round(ms) }, "slow request");
  });

  app.route("/", publicRoutes(d));
  app.route("/", creditsRoutes(d));
  app.route("/", accountRoutes(d));
  app.route("/", walletRoutes(d));
  app.route("/", adminRoutes(d));
  // Products last: their deprecated aliases (/v1/:region/…) must never shadow platform routes.
  app.route("/", productRoutes(d));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    d.log.error({ err, path: c.req.path, requestId: c.get("requestId") }, "unhandled error");
    return c.json({ error: "internal_error", request_id: c.get("requestId") }, 500);
  });

  return app;
}
