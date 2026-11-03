import { describe, expect, it } from "vitest";
import { cleanestWindow, current, series } from "../../../src/products/grid/signals";
import { CUR, periods, T0 } from "./fixtures";

const H = 3_600_000;
// England: 200,190,...,110 then repeats every 5 h (i = half-hours from 17:30).
const P = periods(-2, 48);

describe("grid signals", () => {
  it("series starts at the half-hour containing now and skips nulls", () => {
    const s = series(periods(-1, 3, (i) => (i === 2 ? null : 100 + i)), "england", T0, 2);
    expect(s.map((p) => [p.start - CUR, p.intensity])).toEqual([
      [0, 100],
      [0.5 * H, 101],
      [1.5 * H, 103],
    ]);
  });

  it("current: this half-hour, the next one, and how now ranks in the next 24 h", () => {
    const c = current(P, "england", T0)!;
    expect(c).toMatchObject({ period: { from: "2026-11-03T17:30:00.000Z", to: "2026-11-03T18:00:00.000Z" }, intensity: 200, next: { intensity: 190 }, min_next_24h: 110, max_next_24h: 200 });
    expect(c.share_of_next_24h_cleaner).toBe(0.9); // 200 is the dirtiest value in each 10-period cycle
  });

  it("current is null when this half-hour has no value", () => {
    expect(current(periods(1, 10), "england", T0)).toBeNull();
  });

  it("cleanest window: lowest mean, compared with starting now", () => {
    const w = cleanestWindow(P, "england", T0, 1, 24)!;
    // Lowest pair in each cycle is 120,110 at i=8,9 -> 18:30Z + 4 h... first occurrence wins.
    expect(w).toEqual({
      from: "2026-11-03T21:30:00.000Z",
      to: "2026-11-03T22:30:00.000Z",
      mean_intensity: 115,
      now: { from: "2026-11-03T17:30:00.000Z", mean_intensity: 195 },
      saving_pct: 41,
    });
  });

  it("the window must end within the horizon asked for", () => {
    const w = cleanestWindow(P, "england", T0, 1, 3)!; // only i = 0..5 available
    expect(w.from).toBe("2026-11-03T19:30:00.000Z"); // 160,150 is the best that fits
    expect(cleanestWindow(P, "england", T0, 4, 3)).toBeNull();
  });

  it("skips windows with a missing half-hour", () => {
    const gappy = periods(0, 6, (i) => (i === 3 ? null : i === 2 || i === 4 ? 10 : 500));
    const w = cleanestWindow(gappy, "england", T0, 1, 6)!;
    expect(w.mean_intensity).toBe(255); // [2,3] and [3,4] contain the gap; best contiguous pair holds one 10
  });

  it("returns no 'now' comparison when this half-hour is missing", () => {
    const w = cleanestWindow(periods(1, 10), "england", T0, 1, 10)!;
    expect(w.now).toBeNull();
    expect(w.saving_pct).toBeNull();
  });
});
