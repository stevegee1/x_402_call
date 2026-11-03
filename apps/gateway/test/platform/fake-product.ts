import type { DataMode } from "@mx/shared";
import type { PricedResource, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../src/platform/product";

export interface AcmeState {
  site: string;
  value: number;
}

const site = { name: "site", in: "path" as const, required: true, schema: { type: "string" } };

/**
 * A second product with fully controllable behaviour, used to prove that every money-path
 * invariant is enforced by the kernel for any product, not by maritime code.
 */
export class AcmeProduct implements Product<AcmeState> {
  readonly id = "acme";
  readonly displayName = "Acme Telemetry";
  readonly description = "Test product";
  readonly resources: readonly PricedResource[] = [
    { id: "acme.reading", path: "/:site/reading", summary: "Latest reading for a site", pricing: { kind: "fixed", priceUsd: "0.05", creditsGbpMicros: 40_000 }, parameters: [site] },
    {
      id: "acme.report",
      path: "/:site/reports/:report",
      summary: "One report",
      pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 8_000 },
      parameters: [site, { name: "report", in: "path", required: true, schema: { type: "string" } }],
    },
  ];

  fresh = true;
  mode: DataMode = "live";
  ready = true;
  /** Status the reading handler responds with (≥400 exercises refund / cancel). */
  handlerStatus = 200;
  handlerCalls = 0;
  adminCalls = 0;

  resolve(c: ProductContext): Resolution<AcmeState> | Response {
    const s = c.req.param("site");
    if (s !== "north") return c.json({ error: "unknown_site" }, 404);
    return { scope: { scope: s, fresh: this.fresh, mode: this.mode, sourceTs: Date.now() - 1_000 }, state: { site: s, value: 42 } };
  }

  routes(r: ProductRoutes<AcmeState>): void {
    r.paid("acme.reading", (c, s) => {
      this.handlerCalls++;
      if (this.handlerStatus >= 400) return c.json({ error: "upstream_failed" }, this.handlerStatus as 500);
      return c.json({ site: s.site, value: s.value, mode: this.mode });
    });
    r.paid("acme.report", (c, s) => c.json({ site: s.site, report: c.req.param("report") }), {
      precheck: (c) => (c.req.param("report") === "missing" ? c.json({ error: "report_not_found" }, 404) : null),
    });
    r.free("/sites", (c) => c.json({ data: ["north"] }));
    r.admin("POST", "/reset", (c) => {
      this.adminCalls++;
      return c.json({ ok: true });
    });
  }

  status(): ProductStatus {
    return { ready: this.ready, scopes: [{ scope: "north", fresh: this.fresh, mode: this.mode, sourceTs: null }] };
  }
}
