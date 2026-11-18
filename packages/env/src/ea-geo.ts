import { OBSERVED_AT } from "./ea";
import { pointInGeometry, type GeoJsonGeometry } from "./geo";
import { SITES, type Site } from "./sites";

/**
 * Read-only client for Environment Agency spatial datasets served as OGC API - Features
 * (environment.data.gov.uk/geoservices, Open Government Licence v3.0). For each of our sites it
 * asks for the features around the site and keeps the one whose polygon contains it, so a dataset
 * of England-wide polygons becomes one record per site.
 *
 * Record: { site, feature: <properties> | null, __observedAt }. feature is null when no polygon
 * holds the site (it lies in a gap of the dataset): stored as "missing", never guessed from a
 * neighbour.
 */

export const EA_GEO_ATTRIBUTION = "Contains Environment Agency information © Environment Agency and/or database right";

export interface EaGeoClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  now?: () => number;
  sites?: readonly Site[];
}

/** Half-width of the box asked for around each site, in degrees (about 100 m): small, so few features come back. */
const BOX_DEG = 0.001;
const PAGE = 100;

export interface SiteFeatureRecord {
  site: string;
  feature: Record<string, unknown> | null;
  [OBSERVED_AT]: number;
}

export class EaGeoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sites: readonly Site[];

  constructor(private readonly opts: EaGeoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
    this.now = opts.now ?? Date.now;
    this.sites = opts.sites ?? SITES;
  }

  /** The service answers HEAD with 405 and gives no edition date: cadence comes from the dataset's minFetchIntervalMs. */
  async lastModified(): Promise<number | null> {
    return null;
  }

  /** One record per site. Throws if any site's request fails, so a fetch is all or nothing (the poller retries). */
  async records(itemsPath: string): Promise<SiteFeatureRecord[]> {
    const observedAt = this.now();
    const out: SiteFeatureRecord[] = [];
    for (const s of this.sites) out.push({ site: s.id, feature: await this.featureAt(itemsPath, s), [OBSERVED_AT]: observedAt });
    return out;
  }

  private async featureAt(itemsPath: string, s: Site): Promise<Record<string, unknown> | null> {
    const url = new URL(itemsPath, this.opts.baseUrl);
    url.searchParams.set("f", "json");
    url.searchParams.set("limit", String(PAGE));
    // bbox in CRS84 (lon, lat): the service's default.
    url.searchParams.set("bbox", [s.lon - BOX_DEG, s.lat - BOX_DEG, s.lon + BOX_DEG, s.lat + BOX_DEG].map((v) => v.toFixed(6)).join(","));
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/geo+json, application/json", "user-agent": this.userAgent } });
    if (!res.ok) throw new Error(`EA geo ${itemsPath} HTTP ${res.status}`);
    const body = (await res.json()) as { features?: unknown; numberMatched?: unknown; numberReturned?: unknown };
    if (!Array.isArray(body?.features)) throw new Error(`EA geo ${itemsPath}: unexpected response`);
    if (typeof body.numberMatched === "number" && body.numberMatched > body.features.length) throw new Error(`EA geo ${itemsPath}: ${body.numberMatched} features around ${s.id}, more than one page`);
    const hits = body.features.filter((f): f is { properties: Record<string, unknown>; geometry: GeoJsonGeometry } => {
      const feat = f as { properties?: unknown; geometry?: unknown };
      return !!feat && typeof feat.properties === "object" && feat.properties !== null && pointInGeometry(s.lon, s.lat, feat.geometry as GeoJsonGeometry);
    });
    // Water bodies don't overlap; if two ever claim a site, the answer is ambiguous: don't pick one.
    if (hits.length > 1) throw new Error(`EA geo ${itemsPath}: ${hits.length} polygons contain ${s.id}`);
    return hits[0]?.properties ?? null;
  }
}
