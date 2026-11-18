import { SITES, type Site } from "@mx/env";
import type { Metrics } from "../../metrics";
import type { PricedResource, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../platform/product";
import { SITE_INPUTS, siteSources, type InputKey, type SiteSources } from "./inputs";
import { carbonSection, floodSection, heatSection, pricesSection, riversSection, waterSection, type ReportOptions } from "./report";

const iso = (t: number) => new Date(t).toISOString();

/** The cache must refresh at least this often, as for every product on the version store. */
const MAX_REFRESH_AGE_MS = 2 * 60_000;

/** Inputs each resource reads: a resource is sold only while all of them are fresh (I1). */
const FLOOD_INPUTS: readonly InputKey[] = ["flood", "rivers"];
const ALL_INPUTS: readonly InputKey[] = SITE_INPUTS.map((i) => i.key);

export const SITE_RESOURCES: readonly PricedResource[] = [
  {
    id: "sites.report",
    path: "/:site/report",
    summary:
      "Everything we know about one data-centre site: grid carbon now and the next 24 h, power prices, flood warnings in force, river levels, water availability for abstraction, heat networks nearby. as_of gives the report as it stood then",
    pricing: { kind: "fixed", priceUsd: "0.052", creditsGbpMicros: 42_000 },
    parameters: [
      { name: "site", in: "path", required: true, description: "Site id (see GET /v1/sites/list)", schema: { type: "string", enum: SITES.map((s) => s.id) } },
      { name: "as_of", in: "query", description: "Knowledge time: the report as it stood then (default now; not in the future)", schema: { type: "string", format: "date-time" } },
    ],
  },
  {
    id: "sites.flood",
    path: "/:site/flood",
    summary: "Flood warnings in force on the site's EA flood areas, and river levels at the nearest gauges with their 24 h change. Not for safety-critical use",
    pricing: { kind: "fixed", priceUsd: "0.012", creditsGbpMicros: 10_000 },
    parameters: [{ name: "site", in: "path", required: true, description: "Site id (see GET /v1/sites/list)", schema: { type: "string", enum: SITES.map((s) => s.id) } }],
  },
];

export interface SiteState {
  site: Site;
  now: number;
}

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** as_of: absent (latest), a valid past instant, or an error string (400, never charged). */
export function asOfParam(raw: string | undefined, now: number): number | undefined | string {
  if (raw === undefined) return undefined;
  const t = ISO_ZONED.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) return "as_of must be ISO 8601 with a zone, e.g. 2026-11-18T09:00:00Z";
  if (t > now) return "as_of cannot be in the future";
  return t;
}

/**
 * Site intelligence: reports on the UK data-centre sites in our list (sites.ts), built from the
 * version store. Same rails and rules as every product; a site is keyed by our id, never by
 * buyer-supplied coordinates.
 */
export class SitesProduct implements Product<SiteState> {
  readonly id = "sites";
  readonly displayName = "Site intelligence";
  readonly description =
    "Reports on UK data-centre sites (Slough, Docklands, Hayes): grid carbon and its 24 h outlook, power prices, flood warnings and river levels, water availability for new abstraction, and heat networks that could take waste heat. Every input is point-in-time, so a report can be read as it stood on any past date. Flood data is not for safety-critical use.";
  readonly resources = SITE_RESOURCES;

  constructor(
    private readonly sources: SiteSources,
    private readonly now: () => number = Date.now,
  ) {
    const missing = SITE_INPUTS.filter((i) => !sources.has(i.key)).map((i) => i.key);
    if (missing.length) throw new Error(`sites: no source for ${missing.join(", ")}`);
  }

  /** Inputs that are not fresh now, with why. Empty means sellable. */
  stale(keys: readonly InputKey[], now: number): Array<{ input: InputKey; reason: string }> {
    const out: Array<{ input: InputKey; reason: string }> = [];
    for (const key of keys) {
      const input = SITE_INPUTS.find((i) => i.key === key)!;
      const src = this.sources.get(key)!;
      const refreshed = src.cache.lastRefreshAt;
      const ingest = src.ingestLastSuccessAt();
      if (!src.cache.ready) out.push({ input: key, reason: "cache not loaded" });
      else if (refreshed === null || now - refreshed > MAX_REFRESH_AGE_MS) out.push({ input: key, reason: "store unreachable" });
      else if (ingest === null || now - ingest > input.maxIngestAgeMs) out.push({ input: key, reason: "ingest has not fetched recently" });
    }
    return out;
  }

  resolve(c: ProductContext): Resolution<SiteState> | Response {
    const id = c.req.param("site") ?? "";
    const site = SITES.find((s) => s.id === id);
    if (!site) return c.json({ error: "unknown_site", sites: SITES.map((s) => s.id) }, 404);
    const now = this.now();
    // Each resource is judged on the inputs it reads: a heat-data outage never stops flood reads.
    const keys = c.req.path.endsWith("/flood") ? FLOOD_INPUTS : ALL_INPUTS;
    const sourceTs = Math.min(...keys.map((k) => this.sources.get(k)!.ingestLastSuccessAt() ?? 0));
    return { scope: { scope: site.id, fresh: this.stale(keys, now).length === 0, mode: "live", sourceTs: sourceTs || null }, state: { site, now } };
  }

  private envelope(s: SiteState, extra: Record<string, unknown>) {
    const { site } = s;
    return {
      site: { id: site.id, name: site.name, operator: site.operator, cluster: site.cluster, postcode: site.postcode, lat: site.lat, lon: site.lon, grid_region: site.gridRegion },
      mode: "live",
      generated_at: iso(s.now),
      ...extra,
      sources: siteSources(s.now),
    };
  }

  routes(r: ProductRoutes<SiteState>): void {
    r.free(
      "/list",
      (c) => {
        const now = this.now();
        const stale = this.stale(ALL_INPUTS, now);
        return c.json({
          data: SITES.map((s) => ({
            id: s.id,
            name: s.name,
            operator: s.operator,
            cluster: s.cluster,
            postcode: s.postcode,
            lat: s.lat,
            lon: s.lon,
            grid_region: s.gridRegion,
            source: s.source,
            endpoints: this.resources.map((e) => ({ id: e.id, path: `/v1/${this.id}${e.path.replace(":site", s.id)}`, price_usdc: e.pricing.priceUsd, price_credits_gbp: e.pricing.creditsGbpMicros / 1e6, description: e.summary })),
          })),
          fresh: stale.length === 0,
          stale_inputs: stale,
          note: "Locations are postcode centroids (within a few hundred metres of the building).",
        });
      },
      { summary: "The data-centre sites we report on, with their endpoints and prices" },
    );

    r.paid(
      "sites.report",
      async (c, s) => {
        const asOf = asOfParam(c.req.query("as_of"), s.now) as number | undefined; // validated in the precheck
        const o: ReportOptions = { at: asOf ?? s.now, asOf };
        let sections;
        try {
          const [carbon, prices, flood, rivers, water, heat] = await Promise.all([
            carbonSection(this.sources, s.site, o),
            pricesSection(this.sources, o),
            floodSection(this.sources, s.site, o),
            riversSection(this.sources, s.site, o),
            waterSection(this.sources, s.site, o),
            heatSection(this.sources, s.site, o),
          ]);
          sections = { carbon, prices, flood, rivers, water, heat };
        } catch {
          // A store read failed or ran out of time: refuse, never charged (I5, I15).
          c.header("Retry-After", "15");
          return c.json({ error: "history_unavailable", detail: "site data is temporarily unavailable; you have not been charged" }, 503);
        }
        if (Object.values(sections).every((x) => x === null)) {
          return c.json({ error: "no_history", detail: `nothing was recorded for ${s.site.id} at ${iso(o.at)}; you have not been charged` }, 404);
        }
        return c.json(this.envelope(s, { at: iso(o.at), as_of: asOf === undefined ? null : iso(asOf), ...sections }));
      },
      {
        precheck: (c, s) => {
          const a = asOfParam(c.req.query("as_of"), s.now);
          return typeof a === "string" ? c.json({ error: "invalid_parameters", detail: `${a}; you have not been charged` }, 400) : null;
        },
      },
    );

    r.paid("sites.flood", async (c, s) => {
      const o: ReportOptions = { at: s.now, asOf: undefined };
      try {
        const [flood, rivers] = await Promise.all([floodSection(this.sources, s.site, o), riversSection(this.sources, s.site, o)]);
        if (!flood && !rivers) return c.json({ error: "data_unavailable", detail: "no flood or river data recorded yet; you have not been charged" }, 503);
        return c.json(this.envelope(s, { flood, rivers }));
      } catch {
        c.header("Retry-After", "15");
        return c.json({ error: "history_unavailable", detail: "site data is temporarily unavailable; you have not been charged" }, 503);
      }
    });
  }

  status(): ProductStatus {
    const now = this.now();
    const all = this.stale(ALL_INPUTS, now);
    const flood = this.stale(FLOOD_INPUTS, now);
    return {
      // Stale inputs make calls 503 (uncharged); they never take the gateway out of rotation.
      ready: true,
      scopes: SITES.map((s) => ({ scope: s.id, fresh: all.length === 0, mode: "live" as const, sourceTs: null, flood_fresh: flood.length === 0 })),
      detail: { stale_inputs: all },
    };
  }

  collectMetrics(m: Metrics): void {
    const stale = new Set(this.stale(ALL_INPUTS, this.now()).map((x) => x.input));
    for (const i of SITE_INPUTS) m.set("sites_input_fresh", stale.has(i.key) ? 0 : 1, { input: i.key });
  }
}
