import { PERIOD_MS, type GridSource, type HalfHour } from "../../../src/products/grid/source";

export const T0 = Date.parse("2026-11-03T17:40:00Z"); // inside the 17:30 half-hour
export const CUR = Date.parse("2026-11-03T17:30:00Z");

/** Half-hours from `fromH` to `toH` hours around CUR; England follows `eng(i)`, i = half-hours from CUR. */
export function periods(fromH: number, toH: number, eng: (i: number) => number | null = (i) => 200 - (i % 10) * 10): HalfHour[] {
  const out: HalfHour[] = [];
  for (let i = fromH * 2; i < toH * 2; i++) out.push({ start: CUR + i * PERIOD_MS, values: { england: eng(i), scotland: 20, wales: 300 } });
  return out;
}

/** A NESO datastore record as the API returns it (naive UTC timestamp, numbers or strings). */
export const record = (p: HalfHour) => ({
  _id: p.start / 1000,
  datetime: new Date(p.start).toISOString().slice(0, 19),
  England: p.values.england,
  Scotland: p.values.scotland,
  Wales: p.values.wales,
});

export class FakeSource implements GridSource {
  constructor(public periods: HalfHour[] = [], public failing = false) {}
  async fetch() {
    if (this.failing) throw new Error("NESO down");
    return this.periods;
  }
}
