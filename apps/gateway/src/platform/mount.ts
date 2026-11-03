import { Hono, type MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../context";
import { paid } from "../payments/billing";

/**
 * Marks a response from a pre-platform alias path as deprecated and points at the canonical URL
 * (RFC 9745 Deprecation header, RFC 8288 Link successor-version).
 */
export function deprecatedAlias(canonicalPattern: string, publicBaseUrl: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const canonical = canonicalPattern.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(c.req.param(name) ?? ""));
    c.res.headers.set("Deprecation", "true");
    c.res.headers.set("Link", `<${publicBaseUrl}${canonical}>; rel="successor-version"`);
  };
}

/** Mounts every product's paid and free routes (canonical first, then deprecated aliases). */
export function productRoutes(d: AppDeps) {
  const app = new Hono<AppEnv>();

  for (const route of d.catalog.free) {
    app.get(route.path, (c) => route.handler(c));
  }
  for (const route of d.catalog.paid) {
    const bill = paid(route.product, route.resource, d, route.precheck);
    app.get(route.path, bill, (c) => route.handler(c, c.get("resolution").state));
  }

  // Aliases after all canonical routes, so a canonical path always wins a match.
  for (const route of d.catalog.free) {
    for (const legacy of route.legacyPaths) app.get(legacy, deprecatedAlias(route.path, d.cfg.PUBLIC_BASE_URL), (c) => route.handler(c));
  }
  for (const route of d.catalog.paid) {
    if (!route.resource.legacyPaths?.length) continue;
    const bill = paid(route.product, route.resource, d, route.precheck);
    for (const legacy of route.resource.legacyPaths) {
      app.get(legacy, deprecatedAlias(route.path, d.cfg.PUBLIC_BASE_URL), bill, (c) => route.handler(c, c.get("resolution").state));
    }
  }

  return app;
}
