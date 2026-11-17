import { describe, expect, it } from "vitest";
import { CLUSTER_RIVER_SERIES, cleanFloodWarnings, cleanRiverLevels, EA_FLOOD_WARNINGS, EA_RIVER_LEVELS, EaClient, ENV_DATASETS, FLOOD_PERIOD_MS, NESO_DATASETS, OBSERVED_AT, RIVER_MEASURES, SITES } from "../src";

const T = Date.parse("2026-11-17T07:09:30Z");
const BUCKET = Date.parse("2026-11-17T07:00:00Z");
// Live shape, 2026-11-17.
const warning = (floodAreaID: unknown, severityLevel: unknown, observed: unknown = T) => ({
  floodAreaID,
  severityLevel,
  severity: "Flood alert",
  timeRaised: "2026-11-16T16:06:17",
  isTidal: true,
  eaAreaName: "Wessex",
  [OBSERVED_AT]: observed,
});

describe("EA flood warnings", () => {
  it("stores each listed area's severity for the 15-minute period it was observed in", () => {
    const r = cleanFloodWarnings([warning("111WATCHXH", 3), warning("033WAF312", 2)]);
    expect(r).toEqual({
      observations: [
        { region: "fa_033waf312", validFrom: BUCKET, value: 2, quality: "ok", rawValue: null },
        { region: "fa_111watchxh", validFrom: BUCKET, value: 3, quality: "ok", rawValue: null },
      ],
      dropped: 0,
      duplicates: 0,
    });
    expect(BUCKET % FLOOD_PERIOD_MS).toBe(0);
  });

  it("keeps the most severe warning when an area is listed twice", () => {
    const r = cleanFloodWarnings([warning("111WATCHXH", 3), warning("111WATCHXH", 1), warning("111WATCHXH", 4)]);
    expect(r.observations).toEqual([{ region: "fa_111watchxh", validFrom: BUCKET, value: 1, quality: "ok", rawValue: null }]);
    expect(r.duplicates).toBe(2);
  });

  it("flags bad severities and drops rows it can't place", () => {
    const r = cleanFloodWarnings([warning("A1B", 7), warning("A2B", "3"), warning("A3B", null), warning("bad id!", 2), warning("A4B", 2, "now"), null, []]);
    expect(r.observations.map((o) => [o.region, o.quality, o.rawValue])).toEqual([
      ["fa_a1b", "rejected", "7"],
      ["fa_a2b", "rejected", "3"],
      ["fa_a3b", "missing", null],
    ]);
    expect(r.dropped).toBe(4);
  });

  it("an empty list is a normal fetch: no warnings in force", () => {
    expect(cleanFloodWarnings([])).toEqual({ observations: [], dropped: 0, duplicates: 0 });
    expect(EA_FLOOD_WARNINGS.emptyIsNormal).toBe(true);
  });

  it("is registered as an EA dataset beside the NESO ones, under an id that never changes", () => {
    expect(EA_FLOOD_WARNINGS).toMatchObject({ id: "ea.flood_warnings", source: "ea", periodMs: 900_000 });
    expect(ENV_DATASETS.map((d) => d.id)).toEqual([...NESO_DATASETS.map((d) => d.id), "ea.flood_warnings", "ea.river_levels", "elexon.system_prices", "elexon.market_index"]);
  });
});

describe("EA river levels", () => {
  const M = "http://environment.data.gov.uk/flood-monitoring/id/measures/";
  // Live shape, 2026-11-17.
  const reading = (measure: string, dateTime: unknown, value: unknown) => ({ "@id": "x", dateTime, measure: M + measure, value });

  it("keeps only the gauges we follow, each at its own reading time", () => {
    const r = cleanRiverLevels([
      reading("3650TH-level-stage-i-15_min-mASD", "2026-11-17T11:30:00Z", 0.996),
      reading("0001-level-tidal_level-i-15_min-mAOD", "2026-11-17T11:30:00Z", -1.742),
      reading("2603TH-level-stage-i-15_min-mASD", "2026-11-17T11:15:00Z", 1.787),
      reading("9999XX-level-stage-i-15_min-mASD", "2026-11-17T11:30:00Z", 3), // not followed: ignored, not dropped
    ]);
    expect(r.dropped).toBe(0);
    expect(r.observations.map((o) => [o.region, new Date(o.validFrom).toISOString(), o.value])).toEqual([
      ["st_2603th_masd", "2026-11-17T11:15:00.000Z", 1.787],
      ["st_0001_maod", "2026-11-17T11:30:00.000Z", -1.742],
      ["st_3650th_masd", "2026-11-17T11:30:00.000Z", 0.996],
    ]);
  });

  it("drops readings it can't place and flags impossible levels", () => {
    const r = cleanRiverLevels([
      reading("2603TH-level-stage-i-15_min-mASD", "2026-11-17T11:07:00Z", 1), // off the 15-min grid
      reading("2609TH-level-stage-i-15_min-mASD", "2026-11-17 11:15", 1),
      reading("2698TH-level-stage-i-15_min-mASD", "2026-11-17T11:15:00Z", 9999),
      reading("3629TH-level-stage-i-15_min-mASD", "2026-11-17T11:15:00Z", [1, 2]),
    ]);
    expect(r.dropped).toBe(2);
    expect(r.observations.map((o) => [o.region, o.quality, o.rawValue])).toEqual([
      ["st_2698th_masd", "rejected", "9999"],
      ["st_3629th_masd", "rejected", "[1,2]"],
    ]);
  });

  it("maps every cluster with a site to followed gauges, and every gauge to a cluster", () => {
    for (const s of SITES) expect(CLUSTER_RIVER_SERIES[s.cluster].length, s.id).toBeGreaterThan(0);
    const mapped = Object.values(CLUSTER_RIVER_SERIES).flat();
    expect(new Set(mapped)).toEqual(new Set(Object.keys(RIVER_MEASURES)));
    expect(EA_RIVER_LEVELS.regions).toEqual(Object.keys(RIVER_MEASURES));
  });
});

describe("EaClient", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });

  it("reads Last-Modified with a HEAD request, and stamps each record with when it was observed", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const responses = [new Response(null, { status: 200, headers: { "last-modified": "Tue, 17 Nov 2026 07:03:12 GMT" } }), ok({ items: [{ floodAreaID: "X1", severityLevel: 3 }, "junk"] })];
    const c = new EaClient({
      baseUrl: "https://ea.example",
      now: () => T,
      fetchImpl: (async (url: URL, init: RequestInit) => (calls.push({ url: String(url), method: init.method }), responses.shift()!)) as unknown as typeof fetch,
    });
    expect(await c.lastModified("/flood-monitoring/id/floods")).toBe(Date.parse("2026-11-17T07:03:12Z"));
    expect(await c.records("/flood-monitoring/id/floods")).toEqual([{ floodAreaID: "X1", severityLevel: 3, [OBSERVED_AT]: T }, "junk"]);
    expect(calls).toEqual([
      { url: "https://ea.example/flood-monitoring/id/floods", method: "HEAD" },
      { url: "https://ea.example/flood-monitoring/id/floods", method: "GET" },
    ]);
  });

  it("returns null with no Last-Modified, and throws on HTTP errors or a body with no items", async () => {
    const seq = [new Response(null, { status: 200 }), new Response("busy", { status: 503 }), ok({ nope: 1 })];
    const c = new EaClient({ baseUrl: "https://ea.example", fetchImpl: (async () => seq.shift()!) as unknown as typeof fetch });
    expect(await c.lastModified("/x")).toBeNull();
    await expect(c.records("/x")).rejects.toThrow(/HTTP 503/);
    await expect(c.records("/x")).rejects.toThrow(/unexpected response/);
  });
});
