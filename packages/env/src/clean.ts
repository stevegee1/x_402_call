import type { CleanResult, Observation, Quality } from "./types";

/** One source column that becomes one series ("region") of the dataset. */
export interface ColumnSpec {
  region: string;
  /** Source field name, exactly as NESO spells it. */
  field: string;
  /** Plausible range, inclusive. A value outside it is a source error and is stored as rejected. */
  min: number;
  max: number;
}

export interface CleanerSpec {
  periodMs: number;
  /**
   * The period start (epoch ms UTC) a record describes, or null if it can't be placed with
   * certainty. Must not throw. Returning null drops the record and counts it.
   */
  periodStart(record: Record<string, unknown>): number | null;
  columns: readonly ColumnSpec[];
  /**
   * For resources where one fetch must hold exactly one forecast run: the run a record belongs to,
   * or null if it doesn't say. A fetch holding more than one run (or a record with no run) is
   * refused whole: every record is counted as dropped, nothing is stored.
   */
  run?(record: Record<string, unknown>): string | null;
}

const DECIMAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function cleanValue(raw: unknown, c: ColumnSpec): { value: number | null; quality: Quality; rawValue: string | null } {
  if (raw === null || raw === undefined || raw === "") return { value: null, quality: "missing", rawValue: null };
  // Plain decimals only: Number() would also read "  " as 0 and "0x10" as 16.
  const n = typeof raw === "number" ? raw : typeof raw === "string" && DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isFinite(n) && n >= c.min && n <= c.max) return { value: n, quality: "ok", rawValue: null };
  return { value: null, quality: "rejected", rawValue: typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw)) };
}

/** Same source value: numbers compared as numbers, so 700 and "700" agree. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && DECIMAL.test(v) ? Number(v) : Number.NaN);
  return Number.isFinite(n(a)) && n(a) === n(b);
}

/**
 * Builds a dataset's `clean` function: one observation per column per placed record, sorted by
 * period then column order. Records that can't be placed (not an object, no period start, or a
 * start off the period grid) are dropped and counted. A period repeated with the same values is
 * kept once and the repeats counted; repeated with different values, we can't tell which is right,
 * so the period is dropped (every copy counted). Values are never filled in.
 */
export function makeCleaner(spec: CleanerSpec): (records: readonly unknown[]) => CleanResult {
  return (records) => {
    if (spec.run) {
      const runs = new Set<string | null>();
      for (const r of records) {
        if (!r || typeof r !== "object" || Array.isArray(r)) continue;
        let id: string | null;
        try {
          id = spec.run(r as Record<string, unknown>);
        } catch {
          id = null;
        }
        runs.add(id);
      }
      if (runs.size > 1 || runs.has(null)) return { observations: [], dropped: records.length, duplicates: 0 };
    }
    const byStart = new Map<number, Record<string, unknown>>();
    const copies = new Map<number, number>();
    const conflicted = new Set<number>();
    let dropped = 0;
    let duplicates = 0;
    for (const r of records) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        dropped++;
        continue;
      }
      const rec = r as Record<string, unknown>;
      let start: number | null;
      try {
        start = spec.periodStart(rec);
      } catch {
        start = null;
      }
      if (start === null || !Number.isFinite(start) || start % spec.periodMs !== 0) {
        dropped++;
        continue;
      }
      const prev = byStart.get(start);
      copies.set(start, (copies.get(start) ?? 0) + 1);
      if (prev) {
        duplicates++;
        if (spec.columns.some((c) => !sameValue(prev[c.field], rec[c.field]))) conflicted.add(start);
      } else byStart.set(start, rec);
    }
    for (const start of conflicted) {
      dropped += copies.get(start)!;
      duplicates -= copies.get(start)! - 1;
      byStart.delete(start);
    }
    const observations: Observation[] = [];
    for (const start of [...byStart.keys()].sort((a, b) => a - b)) {
      const rec = byStart.get(start)!;
      for (const c of spec.columns) observations.push({ region: c.region, validFrom: start, ...cleanValue(rec[c.field], c) });
    }
    return { observations, dropped, duplicates };
  };
}
