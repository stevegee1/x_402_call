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
    if (this.fail) throw this.fail;
    // Result fixed at query time, then the reply is held: a row added meanwhile is not in it.
    const out = this.rows.filter((r) => r.seq > after && r.validFrom >= min).slice(0, limit);
    await this.gate;
    this.pages.push(out.length);
    return out;
  }
}

const make = (src: FakeSource, now = () => NOW, pageSize?: number) => new EnvCache(src, { dataset: DS, regions: ["england", "wales"], windowMs: 7 * 24 * H, pageSize }, now);
const vals = (rows: { value: number | null }[]) => rows.map((r) => r.value);

describe("EnvCache", () => {
  it("is not ready and covers nothing before the first refresh", () => {
    const c = make(new FakeSource());
    expect(c.ready).toBe(false);
    expect(c.covers(NOW)).toBe(false);
    expect(c.asOf("england", NOW - H, NOW + H)).toEqual([]);
  });

  it("loads the snapshot, then answers latest and as-of reads from memory", async () => {
    const src = new FakeSource();
    src.add("england", NOW, 200, NOW - 2 * H);
    src.add("england", NOW + P, 210, NOW - 2 * H);
    src.add("england", NOW, 205, NOW - H); // revision
    src.add("wales", NOW, 300, NOW - 2 * H);
    const c = make(src);
    expect(await c.refresh()).toBe(4);
    expect(c.ready).toBe(true);
    expect(c.position).toBe(4);
    expect(c.size).toBe(4);

    expect(vals(c.asOf("england", NOW, NOW + 2 * P))).toEqual([205, 210]);
    expect(vals(c.asOf("england", NOW, NOW + 2 * P, NOW - 90 * 60_000))).toEqual([200, 210]);
    expect(c.asOf("england", NOW, NOW + 2 * P, NOW - 3 * H)).toEqual([]); // nothing known yet
    expect(vals(c.asOf("england", NOW, NOW + 2 * P, NOW - 2 * H))).toEqual([200, 210]); // inclusive
    expect(vals(c.asOf("wales", NOW - H, NOW + H))).toEqual([300]);
    expect(c.asOf("scotland", NOW - H, NOW + H)).toEqual([]);
    expect(c.asOf("england", NOW, NOW + 2 * P)[0]).toEqual({
      region: "england",
      validFrom: NOW,
      value: 205,
      quality: "ok",
      rawValue: null,
      ingestedAt: NOW - H,
      publishedAt: NOW - H - 1_000,
    });
  });

  it("returns a half-open range: from inclusive, to exclusive", async () => {
    const src = new FakeSource();
    for (let i = 0; i < 4; i++) src.add("england", NOW + i * P, i, NOW - H);
    const c = make(src);
    await c.refresh();
    expect(vals(c.asOf("england", NOW + P, NOW + 3 * P))).toEqual([1, 2]);
    expect(vals(c.asOf("england", NOW + P + 1, NOW + 3 * P))).toEqual([2]);
    expect(c.asOf("england", NOW + 3 * P, NOW + 3 * P)).toEqual([]);
  });

  it("lists every revision of a period, oldest first", async () => {
    const src = new FakeSource();
    src.add("england", NOW, 200, NOW - 3 * H);
    src.add("england", NOW, 205, NOW - 2 * H);
    src.add("england", NOW, null, NOW - H);
    const c = make(src);
    await c.refresh();
    expect(c.revisions("england", NOW).map((r) => [r.value, r.quality, r.ingestedAt])).toEqual([
      [200, "ok", NOW - 3 * H],
      [205, "ok", NOW - 2 * H],
      [null, "missing", NOW - H],
    ]);
    expect(c.revisions("england", NOW + P)).toEqual([]);
  });

  it("follows new versions incrementally after the snapshot, without reloading", async () => {
    const src = new FakeSource();
    src.add("england", NOW, 200, NOW - H);
    const c = make(src);
    await c.refresh();
    src.add("england", NOW, 207, NOW);
    src.add("england", NOW + P, 190, NOW);
    expect(await c.refresh()).toBe(2);
    expect(await c.refresh()).toBe(0);
    expect(src.snapshots).toBe(1);
    expect(vals(c.asOf("england", NOW, NOW + H))).toEqual([207, 190]);
  });

  it("pages through a large catch-up", async () => {
    const src = new FakeSource();
    const c = make(src, () => NOW, 2);
    await c.refresh();
    for (let i = 0; i < 5; i++) src.add("england", NOW + i * P, i, NOW);
    expect(await c.refresh()).toBe(5);
    expect(src.pages).toEqual([0, 2, 2, 1]); // first refresh found nothing; then full, full, short page
    expect(c.position).toBe(5);
  });

  it("keeps versions ordered by ingestedAt even if they arrive out of order", async () => {
    // Two writers with skewed clocks: the later commit carries the earlier ingestedAt.
    const src = new FakeSource();
    src.add("england", NOW, 210, NOW - H);
    src.add("england", NOW, 200, NOW - 2 * H);
    const c = make(src);
    await c.refresh();
    expect(vals(c.asOf("england", NOW, NOW + P))).toEqual([210]);
    expect(vals(c.asOf("england", NOW, NOW + P, NOW - 90 * 60_000))).toEqual([200]);
  });

  it("drops periods that leave the window, and says it no longer covers them", async () => {
    let now = NOW;
    const src = new FakeSource();
    src.add("england", NOW - 6 * 24 * H, 1, NOW - 6 * 24 * H);
    src.add("england", NOW, 2, NOW);
    const c = make(src, () => now);
    await c.refresh();
    expect(c.covers(NOW - 6 * 24 * H)).toBe(true);
    now += 2 * 24 * H;
    await c.refresh();
    expect(c.covers(NOW - 6 * 24 * H)).toBe(false);
    expect(c.size).toBe(1);
    expect(vals(c.asOf("england", NOW - 7 * 24 * H, NOW + H))).toEqual([2]);
  });

  it("ignores regions it doesn't serve", async () => {
    const src = new FakeSource();
    src.add("scotland", NOW, 30, NOW);
    const c = make(src);
    expect(await c.refresh()).toBe(0);
    expect(c.position).toBe(1); // still moves past it
  });

  it("tells listeners when new versions arrive, and only then", async () => {
    const src = new FakeSource();
    const c = make(src);
    const seen: number[] = [];
    const off = c.onChange((n) => seen.push(n));
    await c.refresh();
    src.add("england", NOW, 1, NOW);
    await c.refresh();
    off();
    src.add("england", NOW, 2, NOW + 1);
    await c.refresh();
    expect(seen).toEqual([1]);
  });

  it("shares one run between concurrent calls and runs once more for a call made during it", async () => {
    const src = new FakeSource();
    const c = make(src);
    await c.refresh();
    let open!: () => void;
    src.gate = new Promise((r) => (open = r));
    const first = c.refresh();
    src.add("england", NOW, 1, NOW); // arrives while the first run is in flight
    const second = c.refresh();
    expect(second).toBe(first);
    src.gate = undefined; // the re-run's query replies at once
    open();
    expect(await first).toBe(1); // found only by the extra run
    expect(c.position).toBe(1);
    expect(c.asOf("england", NOW, NOW + 1).map((r) => r.value)).toEqual([1]);
  });

  it("propagates a failed refresh and recovers on the next one", async () => {
    const src = new FakeSource();
    src.fail = new Error("db down");
    const c = make(src);
    await expect(c.refresh()).rejects.toThrow("db down");
    expect(c.ready).toBe(false);
    expect(c.lastRefreshAt).toBeNull();
    src.fail = undefined;
    src.add("england", NOW, 1, NOW);
    expect(await c.refresh()).toBe(1);
    expect(c.lastRefreshAt).toBe(NOW);
  });
});
