import { describe, expect, it } from "vitest";
import { FRESHNESS, GridFeed } from "../../../src/products/grid/feed";
import { PERIOD_MS } from "../../../src/products/grid/source";
import { FakeSource, periods, T0 } from "./fixtures";

const H = 3_600_000;
const quiet = { warn: () => {}, info: () => {} };

function setup(initial = periods(-2, 48)) {
  let now = T0;
  const source = new FakeSource(initial);
  const feed = new GridFeed(source, quiet, 600_000, () => now);
  return { feed, source, advance: (ms: number) => (now += ms), at: () => now };
}

describe("grid freshness (I1)", () => {
  it("fresh with a recent fetch, the current half-hour and a healthy horizon", async () => {
    const t = setup();
    expect(t.feed.state("england")).toMatchObject({ fresh: false, reason: "no_data" });
    await t.feed.poll();
    expect(t.feed.state("england")).toMatchObject({ fresh: true, reason: "ok", advancedAt: T0 });
  });

  it("goes stale when fetches keep failing, keeping the last good data meanwhile", async () => {
    const t = setup();
    await t.feed.poll();
    t.source.failing = true;
    t.advance(FRESHNESS.maxFetchAgeMs - 60_000);
    await t.feed.poll();
    expect(t.feed.state("england").fresh).toBe(true);
    expect(t.feed.health()).toMatchObject({ consecutive_failures: 1, last_error: "NESO down" });
    t.advance(2 * 60_000);
    expect(t.feed.state("england")).toMatchObject({ fresh: false, reason: "fetch_stale" });
    t.source.failing = false;
    await t.feed.poll();
    expect(t.feed.state("england").fresh).toBe(true);
  });

  it("a frozen source (horizon stops advancing) goes stale within 3 h, while its data still looks plausible", async () => {
    const t = setup();
    await t.feed.poll(); // the source never changes from here on
    t.advance(FRESHNESS.maxAdvanceAgeMs - 60_000);
    await t.feed.poll();
    expect(t.feed.state("england").fresh).toBe(true);
    t.advance(2 * 60_000);
    await t.feed.poll();
    expect(t.feed.state("england")).toMatchObject({ fresh: false, reason: "not_advancing" });
    expect(t.feed.state("england").horizonEnd! - t.at()).toBeGreaterThan(40 * H); // still 40+ h of "forecast"
  });

  it("an advancing source stays fresh indefinitely", async () => {
    const t = setup();
    await t.feed.poll();
    for (let i = 1; i <= 12; i++) {
      t.advance(PERIOD_MS);
      t.source.periods = periods(-2 + i / 2, 48 + i / 2);
      await t.feed.poll();
      expect(t.feed.state("england").fresh).toBe(true);
    }
  });

  it("at boot, a short horizon is not trusted until it advances", async () => {
    const t = setup(periods(-2, 20)); // only 20 h ahead: possibly frozen already
    await t.feed.poll();
    expect(t.feed.state("england")).toMatchObject({ fresh: false, reason: "not_advancing", advancedAt: null });
    t.source.periods = periods(-2, 20.5);
    await t.feed.poll();
    expect(t.feed.state("england").fresh).toBe(true);
  });

  it("a shrinking horizon is never credited as an advance", async () => {
    const t = setup();
    await t.feed.poll();
    t.advance(2 * H);
    t.source.periods = periods(-2, 40);
    await t.feed.poll();
    expect(t.feed.state("england").advancedAt).toBe(T0);
  });

  it("stale when the horizon is shorter than 12 h, or this half-hour is missing", async () => {
    const short = setup(periods(-2, 11));
    await short.feed.poll();
    expect(short.feed.state("england").reason).toBe("short_horizon");

    const gap = setup(periods(-2, 48, (i) => (i === 0 ? null : 100)));
    await gap.feed.poll();
    expect(gap.feed.state("england")).toMatchObject({ fresh: false, reason: "no_current_period" });
    expect(gap.feed.state("scotland").fresh).toBe(true); // per country
  });

  it("the old regional dataset (last row months ago) is never fresh", async () => {
    const t = setup(periods(-24 * 100, -24 * 99));
    await t.feed.poll();
    expect(t.feed.state("england").fresh).toBe(false);
  });
});
