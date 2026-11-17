/**
 * Read-only client for the Environment Agency real-time flood-monitoring API (Open Government
 * Licence v3.0). Required attribution, wherever the data is shown or sold:
 * "this uses Environment Agency flood and river level data from the real-time data API (Beta)".
 * Not for safety-critical use: the API carries no service-level guarantee.
 */

export const EA_ATTRIBUTION = "this uses Environment Agency flood and river level data from the real-time data API (Beta)";

export interface EaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** For tests: the clock that stamps when a snapshot was observed. */
  now?: () => number;
}

/** Stamped on every record: when we observed this snapshot (epoch ms). Snapshot datasets place periods by it. */
export const OBSERVED_AT = "__observedAt";

export class EaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;

  constructor(private readonly opts: EaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
    this.now = opts.now ?? Date.now;
  }

  private async get(path: string, method: "GET" | "HEAD"): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.opts.baseUrl), {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "application/json", "user-agent": this.userAgent },
    });
    if (!res.ok) throw new Error(`EA ${path} HTTP ${res.status}`);
    return res;
  }

  /** When the resource last changed, from its Last-Modified header, or null if absent. */
  async lastModified(path: string): Promise<number | null> {
    const res = await this.get(path, "HEAD");
    const t = Date.parse(res.headers.get("last-modified") ?? "");
    return Number.isFinite(t) ? t : null;
  }

  /** The resource's `items`, each stamped with when we observed them. `limit` and `sort` don't apply. */
  async records(path: string): Promise<unknown[]> {
    const res = await this.get(path, "GET");
    const observedAt = this.now();
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body?.items)) throw new Error(`EA ${path}: unexpected response`);
    return body.items.map((i) => (i && typeof i === "object" && !Array.isArray(i) ? { ...i, [OBSERVED_AT]: observedAt } : i));
  }
}
