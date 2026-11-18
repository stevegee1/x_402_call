import { parse } from "csv-parse/sync";
import { OBSERVED_AT } from "./ea";

/**
 * Read-only client for a dataset on the UK government data catalogue (data.gov.uk, CKAN) that is
 * published as a series of CSV releases (e.g. the DESNZ Heat Networks Planning Database, quarterly).
 * resourceId = the CKAN package name. Each fetch reads the newest CSV release in full.
 *
 * Records: one per CSV row, as { column: value } (header names trimmed), plus
 * `__observedAt` (when we read it) and `__release` (the release's URL), so a stored version can
 * always be traced to the file it came from.
 */
export const RELEASE_URL = "__release";

export interface CkanCsvClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  now?: () => number;
  /** A release larger than this is refused (a wrong file, not a CSV of records). */
  maxBytes?: number;
}

interface CkanResource {
  url?: unknown;
  format?: unknown;
  created?: unknown;
  last_modified?: unknown;
}

const isCsv = (r: CkanResource) => typeof r.format === "string" && r.format.replace(/^\./, "").trim().toLowerCase() === "csv" && typeof r.url === "string" && r.url.startsWith("https://");
/** CKAN times are naive UTC ("2026-11-18T08:43:23.359222"). */
const ckanTime = (v: unknown) => (typeof v === "string" ? Date.parse(/Z|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`) : NaN);

export class CkanCsvClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly maxBytes: number;

  constructor(private readonly opts: CkanCsvClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  }

  private async get(url: URL | string): Promise<Response> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { "user-agent": this.userAgent } });
    if (!res.ok) throw new Error(`GET ${String(url)} HTTP ${res.status}`);
    return res;
  }

  /** The newest CSV release of a package: its URL and when it was created. */
  async newestRelease(packageName: string): Promise<{ url: string; createdAt: number }> {
    const url = new URL("/api/action/package_show", this.opts.baseUrl);
    url.searchParams.set("id", packageName);
    const body = (await (await this.get(url)).json()) as { success?: unknown; result?: { resources?: unknown } };
    const resources = body?.success === true && Array.isArray(body.result?.resources) ? (body.result.resources as CkanResource[]) : null;
    if (!resources) throw new Error(`CKAN ${packageName}: unexpected response`);
    const csvs = resources.filter(isCsv).map((r) => ({ url: r.url as string, createdAt: ckanTime(r.created) })).filter((r) => Number.isFinite(r.createdAt));
    if (csvs.length === 0) throw new Error(`CKAN ${packageName}: no CSV release`);
    return csvs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  }

  /** When the newest CSV release was created: a new release moves it. */
  async lastModified(packageName: string): Promise<number | null> {
    return (await this.newestRelease(packageName)).createdAt;
  }

  async records(packageName: string): Promise<Record<string, unknown>[]> {
    const release = await this.newestRelease(packageName);
    const res = await this.get(release.url);
    const text = await res.text();
    if (text.length > this.maxBytes) throw new Error(`CKAN ${packageName}: release ${release.url} is ${text.length} bytes, over the ${this.maxBytes} limit`);
    const observedAt = this.now();
    const rows = parse(text, { columns: (h: string[]) => h.map((c) => c.trim()), bom: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
    return rows.map((r) => ({ ...r, [OBSERVED_AT]: observedAt, [RELEASE_URL]: release.url }));
  }
}
