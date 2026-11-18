import { describe, expect, it } from "vitest";
import {
  bngDistanceM,
  CkanCsvClient,
  cleanHeatNetworks,
  cleanWaterAvailability,
  cleanWaterReliability,
  DESNZ_HEAT_NETWORK_DISTANCE,
  DESNZ_HEAT_NETWORKS,
  EA_WATER_AVAILABILITY,
  EaGeoClient,
  haversineM,
  OBSERVED_AT,
  pointInGeometry,
  RELEASE_URL,
  SITES,
  type Site,
} from "../src";

const DAY = 86_400_000;
const T = Date.parse("2026-11-18T10:30:00Z");
const D = Date.parse("2026-11-18T00:00:00Z");

describe("geometry", () => {
  const square = (x: number, y: number, r: number) => [
    [x - r, y - r],
    [x + r, y - r],
    [x + r, y + r],
    [x - r, y + r],
    [x - r, y - r],
  ];
  it("point in polygon, with holes, and in multipolygons", () => {
    const poly = { type: "Polygon", coordinates: [square(0, 0, 10), square(0, 0, 2)] };
    expect(pointInGeometry(5, 5, poly)).toBe(true);
    expect(pointInGeometry(0, 0, poly)).toBe(false); // in the hole
    expect(pointInGeometry(20, 0, poly)).toBe(false);
    const multi = { type: "MultiPolygon", coordinates: [[square(0, 0, 1)], [square(50, 50, 1)]] };
    expect(pointInGeometry(50.5, 49.5, multi)).toBe(true);
    expect(pointInGeometry(25, 25, multi)).toBe(false);
  });

  it("malformed or non-area geometry is never a hit", () => {
    expect(pointInGeometry(0, 0, null)).toBe(false);
    expect(pointInGeometry(0, 0, { type: "Point", coordinates: [0, 0] })).toBe(false);
    expect(pointInGeometry(0, 0, { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] })).toBe(false);
    expect(pointInGeometry(0, 0, { type: "Polygon", coordinates: [[["a", 0], [1, 1], [2, 2], [0, 0]]] })).toBe(false);
  });

  it("every site's BNG position agrees with its lat/lon (distances between sites match within 1%)", () => {
    for (const a of SITES) {
      for (const b of SITES) {
        if (a === b) continue;
        const g = haversineM(a.lat, a.lon, b.lat, b.lon);
        if (g < 2_000) continue; // postcode rounding dominates at short range
        expect(Math.abs(bngDistanceM(a.easting, a.northing, b.easting, b.northing) - g) / g, `${a.id}-${b.id}`).toBeLessThan(0.01);
      }
    }
  });
});

describe("EA water availability at our sites", () => {
  const site: Site = { ...SITES[0]!, id: "s1", lat: 51.5, lon: -0.6 };
  const box = (cx: number, cy: number, r: number) => ({ type: "Polygon", coordinates: [[[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]]] });
  const props = { ea_wb_id: "GB1", camscdsq30: "Yellow", camscdsq50: "Red", camscdsq70: "Red", camscdsq95: "Red", resavail: "less than 30%" };

  function client(features: unknown[], extra: Record<string, unknown> = {}, status = 200) {
    const urls: URL[] = [];
    const c = new EaGeoClient({
      baseUrl: "https://ea.test",
      sites: [site],
      now: () => T,
      fetchImpl: (async (u: URL) => {
        urls.push(u);
        return new Response(JSON.stringify({ type: "FeatureCollection", features, numberMatched: features.length, ...extra }), { status });
      }) as typeof fetch,
    });
    return { c, urls };
  }

  it("asks for a small lon/lat box around the site and keeps the polygon that contains it", async () => {
    const { c, urls } = client([
      { properties: { ...props, ea_wb_id: "NEAR" }, geometry: box(-0.6005, 51.5, 0.0003) }, // beside the site, not containing it
      { properties: props, geometry: box(-0.6, 51.5, 0.01) },
    ]);
    const recs = await c.records("/items");
    expect(recs).toEqual([{ site: "s1", feature: props, [OBSERVED_AT]: T }]);
    expect(urls[0]!.searchParams.get("bbox")).toBe("-0.601000,51.499000,-0.599000,51.501000");
    expect(urls[0]!.searchParams.get("f")).toBe("json");
  });

  it("no polygon at the site: feature null (stored as missing, never borrowed from a neighbour)", async () => {
    const { c } = client([{ properties: props, geometry: box(-0.7, 51.5, 0.01) }]);
    expect((await c.records("/items"))[0]!.feature).toBeNull();
  });

  it("fails the whole fetch on an HTTP error, a truncated page, or an ambiguous site", async () => {
    await expect(client([], {}, 503).c.records("/items")).rejects.toThrow(/HTTP 503/);
    await expect(client([{ properties: props, geometry: box(-0.6, 51.5, 0.01) }], { numberMatched: 500 }).c.records("/items")).rejects.toThrow(/more than one page/);
    await expect(client([{ properties: props, geometry: box(-0.6, 51.5, 0.01) }, { properties: props, geometry: box(-0.6, 51.5, 0.02) }]).c.records("/items")).rejects.toThrow(/2 polygons contain/);
  });

  it("cleans classes per flow percentile and the reliability band, placed on the UTC day it was read", () => {
    const id = SITES[0]!.id;
    const recs = [{ site: id, feature: props, [OBSERVED_AT]: T }];
    expect(cleanWaterAvailability(recs).observations.map((o) => [o.region, o.validFrom, o.value, o.quality])).toEqual([
      [`${id}.q30`, D, 2, "ok"],
      [`${id}.q50`, D, 3, "ok"],
      [`${id}.q70`, D, 3, "ok"],
      [`${id}.q95`, D, 3, "ok"],
    ]);
    expect(cleanWaterReliability(recs).observations).toEqual([{ region: id, validFrom: D, value: 0, quality: "ok", rawValue: null }]);
    expect(cleanWaterReliability([{ site: id, feature: { resavail: "at least 95%" }, [OBSERVED_AT]: T }]).observations[0]!.value).toBe(95);
  });

  it("an unknown label is rejected (kept raw), absence is missing, and unknown sites are dropped", () => {
    const id = SITES[0]!.id;
    const r = cleanWaterAvailability([
      { site: id, feature: { ...props, camscdsq30: "Purple", camscdsq50: null }, [OBSERVED_AT]: T },
      { site: "nowhere", feature: props, [OBSERVED_AT]: T },
      { site: id, feature: props }, // no observation time
    ]);
    expect(r.dropped).toBe(2);
    expect(r.observations[0]).toMatchObject({ region: `${id}.q30`, quality: "rejected", rawValue: "Purple", value: null });
    expect(r.observations[1]).toMatchObject({ region: `${id}.q50`, quality: "missing", value: null });
    expect(cleanWaterAvailability([{ site: id, feature: null, [OBSERVED_AT]: T }]).observations.every((o) => o.quality === "missing")).toBe(true);
  });

  it("declares a series for every site and flow, sampled daily at most every 6 h", () => {
    expect(EA_WATER_AVAILABILITY.regions).toHaveLength(SITES.length * 4);
    expect(EA_WATER_AVAILABILITY.periodMs).toBe(DAY);
    expect(EA_WATER_AVAILABILITY.minFetchIntervalMs).toBe(6 * 3_600_000);
  });
});

describe("DESNZ heat networks near our sites", () => {
  const site: Site = { ...SITES[0]!, id: "s1", easting: 500_000, northing: 200_000 };
  const row = (status: string, dx: number, dy: number, extra: Record<string, unknown> = {}) => ({
    "Development Status (short)": status,
    "X-coordinate": String(500_000 + dx),
    "Y-coordinate": String(200_000 + dy),
    Country: "England",
    [OBSERVED_AT]: T,
    ...extra,
  });
  const values = (rows: unknown[]) => Object.fromEntries(cleanHeatNetworks(rows, [site]).observations.map((o) => [o.region, o.quality === "ok" ? o.value : o.quality]));

  it("counts networks within 2 km by stage, and measures to the nearest live one", () => {
    const v = values([
      row("Operational", 300, 400), // 500 m
      row("Operational", 0, 1_999),
      row("Operational", 0, 2_001), // outside the radius
      row("Under Construction", -1_000, 0),
      row(" Awaiting Construction", 100, 0), // stray space in the source
      row("Application Submitted", 0, -100),
      row("Application Refused", 0, 10), // not coming: ignored
      row("Abandoned", 0, 5),
    ]);
    expect(v).toEqual({ "s1.operational_2km": 2, "s1.construction_2km": 1, "s1.planned_2km": 2, "s1.nearest_live_m": 500 });
  });

  it("a planned network is never the nearest live one; with none live it is missing", () => {
    expect(values([row("Awaiting Construction", 10, 0)])["s1.nearest_live_m"]).toBe("missing");
  });

  it("excludes Northern Ireland (not on the GB grid) and drops rows with no valid location", () => {
    const r = cleanHeatNetworks([row("Operational", 0, 0, { Country: "Northern Ireland" }), row("Operational", 0, 0, { "X-coordinate": "" }), row("Operational", 0, 0, { "Y-coordinate": "n/a" })], [site]);
    expect(r.dropped).toBe(2);
    expect(Object.fromEntries(r.observations.map((o) => [o.region, o.value]))["s1.operational_2km"]).toBe(0);
  });

  it("is placed on the UTC day it was read; an empty read stores nothing", () => {
    expect(cleanHeatNetworks([row("Operational", 0, 0)], [site]).observations[0]!.validFrom).toBe(D);
    expect(cleanHeatNetworks([], [site]).observations).toEqual([]);
  });

  it("splits counts and distance into two datasets, one unit each", () => {
    const rows = [row("Operational", 0, 100)];
    const counts = DESNZ_HEAT_NETWORKS.clean(rows);
    const dist = DESNZ_HEAT_NETWORK_DISTANCE.clean(rows);
    expect(DESNZ_HEAT_NETWORKS.unit).toBe("count");
    expect(DESNZ_HEAT_NETWORK_DISTANCE.unit).toBe("m");
    expect(counts.observations.every((o) => DESNZ_HEAT_NETWORKS.regions.includes(o.region))).toBe(true);
    expect(dist.observations.every((o) => DESNZ_HEAT_NETWORK_DISTANCE.regions.includes(o.region))).toBe(true);
    expect(dist.observations).toHaveLength(SITES.length);
  });
});

describe("CKAN CSV releases", () => {
  function ckan(resources: unknown[], csv: string, opts: { maxBytes?: number } = {}) {
    const got: string[] = [];
    const c = new CkanCsvClient({
      baseUrl: "https://ckan.test",
      now: () => T,
      ...opts,
      fetchImpl: (async (u: URL | string) => {
        got.push(String(u));
        if (String(u).includes("package_show")) return new Response(JSON.stringify({ success: true, result: { resources } }));
        return new Response(csv);
      }) as typeof fetch,
    });
    return { c, got };
  }
  const RES = [
    { format: ".csv", url: "https://assets.test/old.csv", created: "2026-08-10T08:39:36.101918" },
    { format: ".xlsx", url: "https://assets.test/new.xlsx", created: "2026-11-18T08:42:00" },
    { format: ".csv", url: "https://assets.test/new.csv", created: "2026-11-18T08:43:23.359222" },
    { format: "CSV", url: "http://insecure.test/x.csv", created: "2026-12-01T00:00:00" }, // not https: ignored
  ];

  it("reads the newest CSV release, with trimmed headers, quoted commas and a BOM", async () => {
    const { c, got } = ckan(RES, '﻿Ref ID, Site Name ,X-coordinate\n1,"Plant, North",500000\n');
    expect(await c.lastModified("pkg")).toBe(Date.parse("2026-11-18T08:43:23.359Z"));
    const rows = await c.records("pkg");
    expect(rows).toEqual([{ "Ref ID": "1", "Site Name": "Plant, North", "X-coordinate": "500000", [OBSERVED_AT]: T, [RELEASE_URL]: "https://assets.test/new.csv" }]);
    expect(got.at(-1)).toBe("https://assets.test/new.csv");
  });

  it("refuses a package with no CSV, and an oversized release", async () => {
    await expect(ckan([{ format: "xlsx", url: "https://a.test/x.xlsx", created: "2026-01-01" }], "").c.records("pkg")).rejects.toThrow(/no CSV release/);
    await expect(ckan(RES, "a,b\n1,2\n", { maxBytes: 3 }).c.records("pkg")).rejects.toThrow(/over the 3 limit/);
  });
});
