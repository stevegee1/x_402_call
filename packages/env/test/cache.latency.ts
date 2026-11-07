import { describe, expect, it } from "vitest";
import { EnvCache, type CacheSource, type ChangeRow } from "../src";

const P = 30 * 60_000;
const H = 3_600_000;
const NOW = Date.parse("2026-11-07T15:00:00Z");
const DS = "neso.carbon_intensity";

/** A store double: rows in seq order, with the same filtering the SQL does. */
class FakeSource implements CacheSource {
  rows: ChangeRow[] = [];
  snapshots = 0;
  pages: number[] = [];
  fail?: Error;
  gate?: Promise<void>;

  add(region: string, validFrom: number, value: number | null, ingestedAt: number) {
    const seq = this.rows.length + 1;
    this.rows.push({ seq, region, validFrom, value, quality: value === null ? "missing" : "ok", rawValue: null, ingestedAt, publishedAt: ingestedAt - 1_000 });
    return seq;
  }
  async snapshot(dataset: string, regions: readonly string[], min: number) {
    expect(dataset).toBe(DS);
    this.snapshots++;
    if (this.fail) throw this.fail;
    const rows = this.rows.filter((r) => regions.includes(r.region) && r.validFrom >= min);
    return { rows, maxSeq: this.rows.length };
  }
  async changesSince(_d: string, after: number, min: number, limit = 10_000) {
    await this.gate;
    if (this.fail) throw this.fail;
    const out = this.rows.filter((r) => r.seq > after && r.validFrom >= min).slice(0, limit);
    this.pages.push(out.length);
    return out;
  }
}

const make = (src: FakeSource, now = () => NOW, pageSize?: number) => new EnvCache(src, { dataset: DS, regions: ["england", "wales"], windowMs: 7 * 24 * H, pageSize }, now);

/** Latency budget for cache reads; run alone (vitest.latency.config.ts) so other tests don't compete for the CPU. */
describe("EnvCache latency", () => {
  it("answers a week of half-hours quickly", async () => {
    const src = new FakeSource();
    // 7 days back + 2 days ahead, 2 regions, 24 hourly versions each: about 20k versions.
    for (let i = -7 * 48; i < 2 * 48; i++) for (const r of ["england", "wales"]) for (let v = 0; v < 24; v++) src.add(r, NOW + i * P, v, NOW - (24 - v) * H);
    const c = make(src);
    await c.refresh();
    const read = () => c.asOf("england", NOW - 7 * 24 * H, NOW + 2 * 24 * H, NOW - 12 * H);
    expect(read()).toHaveLength(432);
    for (let k = 0; k < 200; k++) read(); // warm up the JIT
    const p99 = () => {
      const t: number[] = [];
      for (let k = 0; k < 500; k++) {
        const t0 = performance.now();
        read();
        t.push(performance.now() - t0);
      }
      return t.sort((a, b) => a - b)[Math.floor(t.length * 0.99)]!;
    };
    // Best of three rounds: a scheduling spike hits one; a regression hits all three.
    const best = Math.min(p99(), p99(), p99());
    if (process.env.LATENCY_REPORT) console.log(`EnvCache 9-day as-of read: p99 ${best.toFixed(3)} ms`);
    // A full 9-day range (432 periods), one binary search per period: well under a millisecond.
    expect(best).toBeLessThan(2);
  });
});
