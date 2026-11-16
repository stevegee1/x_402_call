/** Read-only client for the NESO Data Portal (CKAN action API). */

export interface NesoClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Sent as User-Agent, so NESO can see who is calling. */
  userAgent?: string;
  /**
   * Least time between the starts of two requests from this client, in ms. One client serves
   * every dataset, so this caps the process's total rate however many datasets it polls. NESO asks
   * for at most one datastore request per second. Default 0 (no spacing).
   */
  minIntervalMs?: number;
  /** Requests for these resources go ahead of all others waiting (FIFO within each lane). */
  priorityResourceIds?: readonly string[];
  /** Monotonic clock in ms (default performance.now), so a wall-clock step can't stall the queue. For tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly priority: ReadonlySet<string>;
  private readonly waiting: Array<{ priority: boolean; go: () => void }> = [];
  private lastStart = Number.NEGATIVE_INFINITY;
  private pumping = false;

  constructor(private readonly opts: NesoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.userAgent = opts.userAgent ?? "wearebase-ingest-env";
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.now = opts.now ?? (() => performance.now());
    this.priority = new Set(opts.priorityResourceIds ?? []);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Waits for this request's turn: priority lane first, and never sooner than minIntervalMs after the last start. */
  private turn(resourceId: string): Promise<void> {
    if (this.minIntervalMs <= 0) return Promise.resolve();
    return new Promise<void>((go) => {
      this.waiting.push({ priority: this.priority.has(resourceId), go });
      this.pump();
    });
  }

  /**
   * Releases waiters one at a time. The gap is re-measured after every sleep, so a timer that
   * fires early can't start a request too soon, and a sleep never exceeds minIntervalMs.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.waiting.length > 0) {
          const now = this.now();
          // A clock that stepped backward would otherwise make the last start look up to hours ahead.
          if (now < this.lastStart) this.lastStart = now;
          const wait = this.lastStart + this.minIntervalMs - now;
          if (wait > 0) {
            await this.sleep(Math.min(wait, this.minIntervalMs));
            continue;
          }
          const i = this.waiting.findIndex((w) => w.priority);
          const [next] = this.waiting.splice(i >= 0 ? i : 0, 1);
          this.lastStart = now;
          next!.go();
        }
      } catch {
        // A failing clock or sleep must not wedge the queue: back off one gap on the real timer, then carry on.
        await new Promise((r) => setTimeout(r, this.minIntervalMs));
      } finally {
        this.pumping = false;
      }
      if (this.waiting.length > 0) this.pump();
    })();
  }

  private async action(name: string, params: Record<string, string>): Promise<unknown> {
    await this.turn(params.id ?? params.resource_id ?? "");
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

  /** The first `limit` records in `sort` order, e.g. "datetime desc" for the newest (the caller sorts after cleaning). */
  async records(resourceId: string, limit: number, sort: string): Promise<unknown[]> {
    const r = (await this.action("datastore_search", { resource_id: resourceId, sort, limit: String(limit) })) as {
      records?: unknown;
    } | null;
    if (!r || !Array.isArray(r.records)) throw new Error("NESO datastore_search: unexpected response");
    return r.records;
  }
}
