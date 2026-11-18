import { EnvCache, EnvHistory, type AsOfQuery, type CacheSource, type ChangeRow, type HistoryStore, type StoredObservation } from "@mx/env";
import { TRADING_DATASETS } from "../../../src/products/trading/datasets";
import type { TradingSource } from "../../../src/products/trading";

export const H = 3_600_000;
export const P = 30 * 60_000;
export const DAY = 24 * H;
/** Test "now": 12:10 UTC, inside the 12:00 period. */
export const T0 = Date.parse("2026-11-17T12:10:00Z");
export const CUR = Date.parse("2026-11-17T12:00:00Z");
/** Generation mix is published about 12 days late: its newest period. */
export const GEN_LAST = CUR - 12 * DAY;
/** A carbon period outside every memory window: only the store can answer it. */
export const OLD = CUR - 10 * DAY;

/** The value of the revision (the first version is 5 higher): different per period and series. */
export const value = (validFrom: number, seriesIndex: number) => 100 + seriesIndex * 1_000 + (validFrom - CUR) / P;

/**
 * The version store as ingest-env would leave it. For each period, a first version at T0 - 2 h
 * (5 higher) and a revision at T0 - 1 h (the value above).
 *  - forecasts: periods from -2 h to +48 h;
 *  - prices: the last 6 h up to and including now (no future prices);
 *  - generation mix: one day ending 12 days ago (upstream lag);
 *  - plus one carbon england period 10 days back, first known 10 days back.
 */
export function storeRows(): Array<ChangeRow & { dataset: string }> {
  const rows: Array<ChangeRow & { dataset: string }> = [];
  const add = (dataset: string, region: string, validFrom: number, v: number | null, ingestedAt: number) =>
    rows.push({ dataset, seq: rows.length + 1, region, validFrom, value: v, quality: v === null ? "missing" : "ok", rawValue: null, ingestedAt, publishedAt: ingestedAt - 20_000 });
  for (const d of TRADING_DATASETS) {
    let starts: number[];
    if (d.kind === "price") starts = Array.from({ length: 13 }, (_, i) => CUR - 6 * H + i * P);
    else if (d.kind === "outturn") starts = Array.from({ length: 48 }, (_, i) => GEN_LAST - DAY + (i + 1) * P);
    else starts = Array.from({ length: 101 }, (_, i) => CUR - 2 * H + i * P);
    for (const ingestedAt of [T0 - 2 * H, T0 - H]) {
      for (const s of starts) {
        d.spec.regions.forEach((r, i) => add(d.spec.id, r, s, value(s, i) + (ingestedAt === T0 - 2 * H ? 5 : 0), ingestedAt));
      }
    }
  }
  add("neso.carbon_intensity", "england", OLD, 111, OLD - H);
  return rows;
}

/** CacheSource and HistoryStore over many datasets, with PgEnvStore's semantics (tested against Postgres in packages/env). */
export class MultiFakeStore implements CacheSource, HistoryStore {
  calls: string[] = [];
  down = false;
  constructor(public rows: Array<ChangeRow & { dataset: string }>) {}
  private strip = ({ seq: _s, dataset: _d, ...o }: ChangeRow & { dataset: string }): StoredObservation => o;
  async snapshot(dataset: string, regions: readonly string[], min: number) {
    const rows = this.rows.filter((r) => r.dataset === dataset && regions.includes(r.region) && r.validFrom >= min);
    return { rows: rows.map(({ dataset: _d, ...r }) => r), maxSeq: Math.max(0, ...this.rows.filter((r) => r.dataset === dataset).map((r) => r.seq)) };
  }
  async changesSince(dataset: string, after: number, min: number) {
    return this.rows.filter((r) => r.dataset === dataset && r.seq > after && r.validFrom >= min).map(({ dataset: _d, ...r }) => r);
  }
  async asOf(q: AsOfQuery): Promise<StoredObservation[]> {
    this.calls.push(`asOf:${q.dataset}`);
    if (this.down) throw new Error("db down");
    const best = new Map<number, ChangeRow & { dataset: string }>();
    for (const r of this.rows) {
      if (r.dataset !== q.dataset || r.region !== q.region || r.validFrom < q.from || r.validFrom >= q.to) continue;
      if (q.asOf !== undefined && r.ingestedAt > q.asOf) continue;
      const cur = best.get(r.validFrom);
      if (!cur || r.ingestedAt > cur.ingestedAt) best.set(r.validFrom, r);
    }
    return [...best.values()].sort((a, b) => a.validFrom - b.validFrom).map(this.strip);
  }
  async firstPeriod(dataset: string, region: string): Promise<number | null> {
    if (this.down) throw new Error("db down");
    const starts = this.rows.filter((r) => r.dataset === dataset && r.region === region).map((r) => r.validFrom);
    return starts.length ? Math.min(...starts) : null;
  }
  async revisions(dataset: string, region: string, validFrom: number): Promise<StoredObservation[]> {
    this.calls.push(`revisions:${dataset}`);
    if (this.down) throw new Error("db down");
    return this.rows
      .filter((r) => r.dataset === dataset && r.region === region && r.validFrom === validFrom)
      .sort((a, b) => a.ingestedAt - b.ingestedAt)
      .map(this.strip);
  }
  /** Appends a new version (as ingest-env would), returning its seq. */
  append(dataset: string, region: string, validFrom: number, v: number, ingestedAt: number): number {
    const seq = Math.max(0, ...this.rows.map((r) => r.seq)) + 1;
    this.rows.push({ dataset, seq, region, validFrom, value: v, quality: "ok", rawValue: null, ingestedAt, publishedAt: null });
    return seq;
  }
}

/** One loaded source per trading dataset, with a settable ingest time per dataset. */
export async function tradingSources(store: MultiFakeStore, ingestAt: Map<string, number | null>) {
  const sources = new Map<string, TradingSource>();
  const caches = new Map<string, EnvCache>();
  for (const d of TRADING_DATASETS) {
    const cache = new EnvCache(store, { dataset: d.spec.id, regions: d.spec.regions, windowMs: d.memoryMs });
    await cache.refresh();
    caches.set(d.key, cache);
    sources.set(d.key, { cache, history: new EnvHistory(cache, store), ingestLastSuccessAt: () => (ingestAt.has(d.key) ? ingestAt.get(d.key)! : T0 - 60_000) });
  }
  return { sources, caches };
}
