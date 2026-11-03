import { PERIOD_MS, type Country, type HalfHour } from "./source";

export interface Point {
  start: number;
  intensity: number;
}

/** The country's series from the half-hour containing `now`, up to `hours` ahead, nulls removed. */
export function series(periods: readonly HalfHour[], country: Country, now: number, hours: number): Point[] {
  const from = now - (now % PERIOD_MS);
  const to = from + hours * 3_600_000;
  return periods
    .filter((p) => p.start >= from && p.start < to && p.values[country] !== null)
    .map((p) => ({ start: p.start, intensity: p.values[country]! }));
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function current(periods: readonly HalfHour[], country: Country, now: number) {
  const next24 = series(periods, country, now, 24);
  const cur = next24[0];
  if (!cur || cur.start > now) return null;
  const cleaner = next24.filter((p) => p.intensity < cur.intensity).length;
  return {
    period: { from: iso(cur.start), to: iso(cur.start + PERIOD_MS) },
    intensity: cur.intensity,
    next: next24[1] ? { from: iso(next24[1].start), intensity: next24[1].intensity } : null,
    // Relative, not an absolute band: share of the next 24 h forecast to be cleaner than now.
    share_of_next_24h_cleaner: next24.length ? Math.round((cleaner / next24.length) * 100) / 100 : null,
    min_next_24h: Math.min(...next24.map((p) => p.intensity)),
    max_next_24h: Math.max(...next24.map((p) => p.intensity)),
  };
}

export interface WindowResult {
  from: string;
  to: string;
  mean_intensity: number;
  /** Running now instead, for comparison (same duration, starting this half-hour). */
  now: { from: string; mean_intensity: number } | null;
  saving_pct: number | null;
}

/**
 * Cleanest contiguous window of `durationH` hours that starts at or after this half-hour and ends
 * within `withinH` hours. Ties go to the earliest. Windows with a missing half-hour are skipped.
 */
export function cleanestWindow(periods: readonly HalfHour[], country: Country, now: number, durationH: number, withinH: number): WindowResult | null {
  const pts = series(periods, country, now, withinH);
  const k = Math.round(durationH * 2);
  let best: { i: number; mean: number } | null = null;
  let nowMean: number | null = null;
  for (let i = 0; i + k <= pts.length; i++) {
    const w = pts.slice(i, i + k);
    if (w[k - 1]!.start - w[0]!.start !== (k - 1) * PERIOD_MS) continue; // gap: not contiguous
    const mean = w.reduce((s, p) => s + p.intensity, 0) / k;
    if (i === 0 && w[0]!.start <= now) nowMean = mean;
    if (!best || mean < best.mean - 1e-9) best = { i, mean };
  }
  if (!best) return null;
  const start = pts[best.i]!.start;
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    from: iso(start),
    to: iso(start + k * PERIOD_MS),
    mean_intensity: round(best.mean),
    now: nowMean === null ? null : { from: iso(pts[0]!.start), mean_intensity: round(nowMean) },
    saving_pct: nowMean === null || nowMean === 0 ? null : Math.round(((nowMean - best.mean) / nowMean) * 1000) / 10,
  };
}
