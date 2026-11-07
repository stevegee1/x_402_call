/** Read-only client for the NESO Data Portal (CKAN action API). */

export interface NesoClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Sent as User-Agent, so NESO can see who is calling. */
  userAgent?: string;
}

/** CKAN reports naive ISO timestamps in UTC, e.g. "2026-11-07T14:10:28.970501". */
const CKAN_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
export function parseCkanTimestamp(v: unknown): number | null {
  if (typeof v !== "string" || !CKAN_TS.test(v)) return null;
  // Date.parse keeps milliseconds only; trim microseconds so every engine parses it the same way.
  const t = Date.parse(`${v.replace(/(\.\d{3})\d+$/, "$1")}Z`);
  return Number.isFinite(t) ? t : null;
}

export class NesoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly opts: NesoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
  }

  private async action(name: string, params: Record<string, string>): Promise<unknown> {
    const u = new URL(`/api/3/action/${name}`, this.opts.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.fetchImpl(u, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "application/json", "user-agent": this.userAgent },
    });
    if (!res.ok) throw new Error(`NESO ${name} HTTP ${res.status}`);
    const body = (await res.json()) as { success?: unknown; result?: unknown };
    if (body?.success !== true || body.result === undefined) throw new Error(`NESO ${name}: unexpected response`);
    return body.result;
  }

  /**
   * When the resource's data last changed, by NESO's clock (epoch ms), or null if NESO doesn't say.
   * Cheap compared with reading the records, so the poller calls it often and fetches only on change.
   */
  async lastModified(resourceId: string): Promise<number | null> {
    const r = (await this.action("resource_show", { id: resourceId })) as Record<string, unknown> | null;
    if (!r || typeof r !== "object") throw new Error("NESO resource_show: unexpected response");
    return parseCkanTimestamp(r.last_modified) ?? parseCkanTimestamp(r.metadata_modified);
  }

  /** The newest `limit` records, newest first (the caller sorts after cleaning). */
  async records(resourceId: string, limit: number): Promise<unknown[]> {
    const r = (await this.action("datastore_search", { resource_id: resourceId, sort: "datetime desc", limit: String(limit) })) as {
      records?: unknown;
    } | null;
    if (!r || !Array.isArray(r.records)) throw new Error("NESO datastore_search: unexpected response");
    return r.records;
  }
}
