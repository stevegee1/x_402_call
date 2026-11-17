import { addDays, londonWallClock } from "./time";

/**
 * Read-only client for the Elexon Insights Solution API (BMRS). Use cleared with Elexon by the
 * user, 2026-11-17. Attribution wherever the data is shown or sold (confirm the exact wording with
 * Elexon): "Contains BMRS data © Elexon Limited copyright and database right <year>".
 *
 * Resource templates: `{date}` = each of the last two UK settlement dates (today and yesterday,
 * so late periods and revisions are re-read); `{from}` / `{to}` = 48 h ago and 1 h ahead, ISO.
 */
export const ELEXON_ATTRIBUTION = (year: number) => `Contains BMRS data © Elexon Limited copyright and database right ${year}`;

export interface ElexonClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  now?: () => number;
}

export class ElexonClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;

  constructor(private readonly opts: ElexonClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
    this.now = opts.now ?? Date.now;
  }

  /** Elexon publishes no Last-Modified: the poller falls back to the dataset's minimum fetch interval. */
  async lastModified(): Promise<number | null> {
    return null;
  }

  /** The paths a template expands to right now. */
  paths(template: string): string[] {
    const t = this.now();
    if (template.includes("{date}")) {
      const today = londonWallClock(t).slice(0, 10);
      return [addDays(today, -1)!, today].map((d) => template.replace("{date}", d));
    }
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    return [template.replace("{from}", iso(t - 48 * 3_600_000)).replace("{to}", iso(t + 3_600_000))];
  }

  async records(template: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const path of this.paths(template)) {
      const res = await this.fetchImpl(new URL(`/bmrs/api/v1${path}`, this.opts.baseUrl), {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", "user-agent": this.userAgent },
      });
      if (!res.ok) throw new Error(`Elexon ${path.split("?")[0]} HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body?.data)) throw new Error(`Elexon ${path.split("?")[0]}: unexpected response`);
      out.push(...body.data);
    }
    return out;
  }
}
