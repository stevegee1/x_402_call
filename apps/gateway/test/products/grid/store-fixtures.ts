import type { AsOfQuery, CacheSource, ChangeRow, StoredObservation } from "@mx/env";
import type { HistoryStore } from "../../../src/products/grid/history";
import { CUR, periods, T0 } from "./fixtures";

const H = 3_600_000;
const DAY = 24 * H;

/**
 * The version store as ingest-env would leave it: for every half-hour from -2 h to +48 h, a first
 * forecast at T0 - 2 h (5 higher) and a revision at T0 - 1 h equal to the fixture values. Plus one
 * period 10 days back, outside the memory window, that only the store can answer.
 */
export function storeRows(): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const add = (region: string, validFrom: number, value: number | null, ingestedAt: number) =>
    rows.push({ seq: rows.length + 1, region, validFrom, value, quality: value === null ? "missing" : "ok", rawValue: null, ingestedAt, publishedAt: ingestedAt - 20_000 });
  const OLD = CUR - 10 * DAY;
  for (const c of ["england", "scotland", "wales"] as const) add(c, OLD, 111, OLD - H);
  for (const p of periods(-2, 48)) for (const c of ["england", "scotland", "wales"] as const) add(c, p.start, p.values[c]! + 5, T0 - 2 * H);
  for (const p of periods(-2, 48)) for (const c of ["england", "scotland", "wales"] as const) add(c, p.start, p.values[c], T0 - H);
  return rows;
}

export class FakeStore implements CacheSource, HistoryStore {
  calls: string[] = [];
  down = false;
  constructor(public rows: ChangeRow[]) {}
  async snapshot(_d: string, regions: readonly string[], min: number) {
    return { rows: this.rows.filter((r) => regions.includes(r.region) && r.validFrom >= min), maxSeq: this.rows.length };
  }
  async changesSince(_d: string, after: number, min: number) {
    return this.rows.filter((r) => r.seq > after && r.validFrom >= min);
  }
  // Same semantics as PgEnvStore.asOf / revisions (those are tested against Postgres in packages/env).
  async asOf(q: AsOfQuery): Promise<StoredObservation[]> {
    this.calls.push("asOf");
    if (this.down) throw new Error("db down");
    const best = new Map<number, ChangeRow>();
    for (const r of this.rows) {
      if (r.region !== q.region || r.validFrom < q.from || r.validFrom >= q.to) continue;
      if (q.asOf !== undefined && r.ingestedAt > q.asOf) continue;
      const cur = best.get(r.validFrom);
      if (!cur || r.ingestedAt > cur.ingestedAt) best.set(r.validFrom, r);
    }
    return [...best.values()].sort((a, b) => a.validFrom - b.validFrom).map(({ seq: _, ...o }) => o);
  }
  async revisions(_d: string, region: string, validFrom: number): Promise<StoredObservation[]> {
    this.calls.push("revisions");
    if (this.down) throw new Error("db down");
    return this.rows.filter((r) => r.region === region && r.validFrom === validFrom).sort((a, b) => a.ingestedAt - b.ingestedAt).map(({ seq: _, ...o }) => o);
  }
}

