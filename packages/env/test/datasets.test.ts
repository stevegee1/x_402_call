import { describe, expect, it } from "vitest";
import {
  CARBON_INTENSITY,
  cleanDemandForecast214d,
  cleanEmbeddedWindSolar,
  cleanGenerationMix,
  cleanRegionalCarbonIntensity,
  cleanWindForecast14d,
  DEMAND_FORECAST_2_14D,
  EMBEDDED_WIND_SOLAR,
  GENERATION_MIX,
  HALF_HOUR_MS,
  NESO_DATASETS,
  REGIONAL_CARBON_INTENSITY,
  WIND_FORECAST_14D,
} from "../src";

const Z = (s: string) => Date.parse(`${s}Z`);
const starts = (r: { observations: Array<{ validFrom: number }> }) => [...new Set(r.observations.map((o) => o.validFrom))];

describe("NESO_DATASETS", () => {
  it("lists every dataset once, carbon intensity first, under ids that never change", () => {
    // Ids are stored with every row: renaming one orphans its history. Change this list only by adding.
    expect(NESO_DATASETS.map((d) => d.id)).toEqual([
      "neso.carbon_intensity",
      "neso.regional_carbon_intensity",
      "neso.embedded_wind_solar_forecast",
      "neso.wind_forecast_14d",
      "neso.demand_forecast_2_14d",
      "neso.generation_mix",
    ]);
    expect(NESO_DATASETS[0]).toBe(CARBON_INTENSITY);
    expect(new Set(NESO_DATASETS.map((d) => d.resourceId)).size).toBe(NESO_DATASETS.length);
  });

  it("gives each dataset distinct series keys, half-hour periods and a sane fetch size", () => {
    for (const d of NESO_DATASETS) {
      expect(new Set(d.regions).size, d.id).toBe(d.regions.length);
      for (const r of d.regions) expect(r, d.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(d.periodMs).toBe(HALF_HOUR_MS);
      expect(d.sort, d.id).toMatch(/ desc$/);
      // A whole-run resource holds ~13-14 days (~670 rows): leave room so a longer run isn't cut.
      if (d.wholeResource) expect(d.fetchLimit, d.id).toBeGreaterThanOrEqual(2 * 14 * 48);
    }
  });

  it("cleans an empty fetch to nothing, for every dataset", () => {
    for (const d of NESO_DATASETS) expect(d.clean([])).toEqual({ observations: [], dropped: 0, duplicates: 0 });
  });

  it("drops non-object rows for every dataset, never throws", () => {
    for (const d of NESO_DATASETS) {
      const r = d.clean([null, 1, "x", [], {}, { _id: 1 }]);
      expect(r.observations, d.id).toEqual([]);
      expect(r.dropped, d.id).toBe(6);
    }
  });
});

describe("regional carbon intensity", () => {
  const live = {
    _id: 1360600595,
    datetime: "2026-11-18T12:30:00",
    "North Scotland": 0,
    "South Scotland": 7,
    "North West England": 41,
    "North East England": 30,
    Yorkshire: 298,
    "North Wales and Merseyside": 183,
    "South Wales": 157,
    "West Midlands": 39,
    "East Midlands": 340,
    "East England": 61,
    "South West England": 90,
    "South England": 152,
    London: 192,
    "South East England": 70,
  };

  it("maps all 14 regions from a live row", () => {
    const r = cleanRegionalCarbonIntensity([live]);
    expect(r.dropped).toBe(0);
    expect(r.observations).toHaveLength(14);
    expect(r.observations.every((o) => o.validFrom === Z("2026-11-18T12:30:00") && o.quality === "ok")).toBe(true);
    expect(Object.fromEntries(r.observations.map((o) => [o.region, o.value]))).toMatchObject({ london: 192, south_england: 152, north_scotland: 0, north_wales_merseyside: 183 });
    expect(r.observations.map((o) => o.region)).toEqual([...REGIONAL_CARBON_INTENSITY.regions]);
  });

  it("flags a region NESO dropped as missing, not the whole row", () => {
    const { London: _, ...noLondon } = live;
    const r = cleanRegionalCarbonIntensity([noLondon]);
    expect(r.observations.find((o) => o.region === "london")).toMatchObject({ quality: "missing", value: null });
    expect(r.observations.filter((o) => o.quality === "ok")).toHaveLength(13);
  });
});

describe("generation mix", () => {
  const live = {
    _id: 25231210,
    DATETIME: "2026-11-04T23:30:00",
    GAS: 9937.0,
    COAL: 0.0,
    NUCLEAR: 3982.0,
    WIND: 9204.0,
    WIND_EMB: 1172.0,
    HYDRO: 412.0,
    IMPORTS: 5201.0,
    BIOMASS: 1203.0,
    OTHER: 194.0,
    SOLAR: 0.0,
    STORAGE: 0,
    GENERATION: 31305.0,
    CARBON_INTENSITY: 185.0,
    GAS_perc: 31.7,
  };

  it("maps the MW columns only, by period start in UTC", () => {
    const r = cleanGenerationMix([live]);
    expect(r.observations.map((o) => o.region)).toEqual([...GENERATION_MIX.regions]);
    expect(GENERATION_MIX.regions).not.toContain("carbon_intensity");
    expect(r.observations.every((o) => o.validFrom === Z("2026-11-04T23:30:00"))).toBe(true);
    expect(Object.fromEntries(r.observations.map((o) => [o.region, o.value]))).toMatchObject({ gas: 9937, wind_embedded: 1172, generation: 31305, storage: 0 });
  });

  it("rejects negative and absurd MW, keeping the raw value", () => {
    const r = cleanGenerationMix([{ ...live, GAS: -5, WIND: 250_000 }]);
    expect(r.observations.find((o) => o.region === "gas")).toMatchObject({ quality: "rejected", rawValue: "-5" });
    expect(r.observations.find((o) => o.region === "wind")).toMatchObject({ quality: "rejected", rawValue: "250000" });
  });
});

describe("embedded wind and solar", () => {
  const row = (SETTLEMENT_DATE: string, SETTLEMENT_PERIOD: unknown, DATE_GMT: string, TIME_GMT: unknown, extra: object = {}) => ({
    _id: 1,
    DATE_GMT,
    TIME_GMT,
    SETTLEMENT_DATE,
    SETTLEMENT_PERIOD,
    EMBEDDED_WIND_FORECAST: 770,
    EMBEDDED_WIND_CAPACITY: 5908,
    EMBEDDED_SOLAR_FORECAST: 4566,
    EMBEDDED_SOLAR_CAPACITY: 23963,
    ...extra,
  });

  it("places live winter rows by settlement period, end label cross-checked", () => {
    const r = cleanEmbeddedWindSolar([
      row("2026-11-16T00:00:00", 21, "2026-11-16T00:00:00", "10:30"),
      row("2026-11-16T00:00:00", 48, "2026-11-17T00:00:00", "00:00"), // SP 48 ends at midnight, next day
      row("2026-11-17T00:00:00", 1, "2026-11-17T00:00:00", "00:30"),
    ]);
    expect(r.dropped).toBe(0);
    expect(starts(r)).toEqual([Z("2026-11-16T10:00:00"), Z("2026-11-16T23:30:00"), Z("2026-11-17T00:00:00")]);
    expect(r.observations.slice(0, 4).map((o) => [o.region, o.value])).toEqual([
      ["wind", 770],
      ["wind_capacity", 5908],
      ["solar", 4566],
      ["solar_capacity", 23963],
    ]);
    expect(EMBEDDED_WIND_SOLAR.regions).toEqual(["wind", "wind_capacity", "solar", "solar_capacity"]);
  });

  it("places archived BST rows an hour earlier in UTC (2025-07-15 SP 1 ends 23:30 UTC the day before)", () => {
    const r = cleanEmbeddedWindSolar([row("2025-07-15T00:00:00", 1, "2025-07-14T00:00:00", "23:30:00")]);
    expect(starts(r)).toEqual([Z("2025-07-14T23:00:00")]);
  });

  it("handles the 50-period autumn day: SP 3 and SP 5 are both 01:00 local, an hour apart in UTC", () => {
    const r = cleanEmbeddedWindSolar([
      row("2026-10-25", 3, "2026-10-25", "00:30"),
      row("2026-10-25", 5, "2026-10-25", "01:30"),
      row("2026-10-25", 50, "2026-10-26", "00:00"),
    ]);
    expect(r.dropped).toBe(0);
    expect(starts(r)).toEqual([Z("2026-10-25T00:00:00"), Z("2026-10-25T01:00:00"), Z("2026-10-25T23:30:00")]);
  });

  it("drops rows whose labels disagree or name a period that doesn't exist", () => {
    const r = cleanEmbeddedWindSolar([
      row("2026-11-16", 21, "2026-11-16", "10:00"), // label is the start, not the end: format change
      row("2026-11-16", 21, "2026-11-16", "11:30"), // an hour out: a local-time label
      row("2026-11-16", 49, "2026-11-17", "00:30"), // no SP 49 on a normal day
      row("2026-03-29", 47, "2026-03-29", "23:30"), // no SP 47 on the spring change day
      row("2026-11-16", 21, "2026-11-16", "24:00"),
      row("2026-11-16", 21, "2026-11-16", undefined),
      row("2026-11-16", "x", "2026-11-16", "10:30"),
      row("2026-11-16T10:00:00", 21, "2026-11-16", "10:30"),
    ]);
    expect(r.dropped).toBe(8);
    expect(r.observations).toEqual([]);
  });

  it("accepts numeric strings for the period and seconds on the time", () => {
    const r = cleanEmbeddedWindSolar([row("2026-11-16", "21", "2026-11-16", "10:30:00")]);
    expect(starts(r)).toEqual([Z("2026-11-16T10:00:00")]);
  });
});

describe("14-day wind forecast", () => {
  const row = (Date: string, Settlement_Period: unknown, Datetime: unknown) => ({
    _id: 1,
    Datetime,
    Date,
    Settlement_Period,
    Capacity: 25564,
    Wind_Forecast: 9097,
    ForecastDateTime: "2026-11-16T10:00:00",
  });

  it("places live rows by settlement period", () => {
    const r = cleanWindForecast14d([row("2026-11-16", 18, "2026-11-16T08:30:00"), row("2026-11-17", 1, "2026-11-17T00:00:00"), row("2026-11-16", 48, "2026-11-16T23:30:00")]);
    expect(r.dropped).toBe(0);
    expect(starts(r)).toEqual([Z("2026-11-16T08:30:00"), Z("2026-11-16T23:30:00"), Z("2026-11-17T00:00:00")]);
    expect(r.observations.slice(0, 2).map((o) => [o.region, o.value])).toEqual([
      ["wind", 9097],
      ["wind_capacity", 25564],
    ]);
    expect(WIND_FORECAST_14D.regions).toEqual(["wind", "wind_capacity"]);
  });

  it("in BST, places SP 1 at 23:00 UTC when Datetime is the UTC start", () => {
    expect(starts(cleanWindForecast14d([row("2026-07-01", 1, "2026-06-30T23:00:00")]))).toEqual([Z("2026-06-30T23:00:00")]);
  });

  it("in BST, drops a local-time label rather than accept two readings an hour apart", () => {
    // With both readings allowed, SP 21 labelled 10:00 (a UTC-counted SP and a true UTC start)
    // would pass as "local" and be stored at 09:00Z, an hour early. One strict reading stops it.
    const r = cleanWindForecast14d([row("2026-07-01", 1, "2026-07-01T00:00:00"), row("2026-07-01", 21, "2026-07-01T10:00:00")]);
    expect(r.dropped).toBe(2);
    expect(r.observations).toEqual([]);
  });

  it("refuses a fetch that mixes forecast runs, or has a row with no run", () => {
    const a = row("2026-11-16", 18, "2026-11-16T08:30:00");
    const b = { ...row("2026-11-16", 19, "2026-11-16T09:00:00"), ForecastDateTime: "2026-11-16T13:00:00" };
    expect(cleanWindForecast14d([a, b])).toEqual({ observations: [], dropped: 2, duplicates: 0 });
    expect(cleanWindForecast14d([a, { ...b, ForecastDateTime: null }]).dropped).toBe(2);
    expect(cleanWindForecast14d([a, { ...b, ForecastDateTime: "2026-11-16T10:00:00" }]).dropped).toBe(0);
  });

  it("drops rows whose Datetime matches the period in neither reading", () => {
    const r = cleanWindForecast14d([row("2026-11-16", 18, "2026-11-16T09:00:00"), row("2026-11-16", 18, "2026-11-16T08:30:00Z"), row("2026-11-16", 18, null), row("2026-11-16", 49, "2026-11-17T00:00:00")]);
    // (All four share one run, so only placement drops them.)
    expect(r.dropped).toBe(4);
  });
});

describe("repeated periods in whole-run resources", () => {
  it("drops a period two runs disagree on, as a read taken mid-replace would show", () => {
    const row = (sp: number, wind: number) => ({ SETTLEMENT_DATE: "2026-11-16", SETTLEMENT_PERIOD: sp, DATE_GMT: "2026-11-16", TIME_GMT: `${String(Math.floor(sp / 2)).padStart(2, "0")}:${sp % 2 ? "30" : "00"}`, EMBEDDED_WIND_FORECAST: wind, EMBEDDED_WIND_CAPACITY: 5908, EMBEDDED_SOLAR_FORECAST: 0, EMBEDDED_SOLAR_CAPACITY: 23963 });
    const r = cleanEmbeddedWindSolar([row(21, 700), row(22, 650), row(21, 710)]);
    expect(r).toMatchObject({ dropped: 2, duplicates: 0 });
    expect(starts(r)).toEqual([Z("2026-11-16T10:30:00")]);
  });

  it("drops conflicting generation-mix rows for one period instead of keeping an arbitrary one", () => {
    const r = cleanGenerationMix([{ DATETIME: "2026-10-25T01:00:00", GAS: 100 }, { DATETIME: "2026-10-25T01:00:00", GAS: 9999 }]);
    expect(r).toEqual({ observations: [], dropped: 2, duplicates: 0 });
  });
});

describe("2-14 day demand forecast", () => {
  const row = (DATE: string, CTIME: unknown, GDATETIME: unknown, NATIONALDEMAND: unknown = 27045) => ({ _id: 1, DATE, CTIME, GDATETIME, NATIONALDEMAND });

  it("places live rows by their end label, including CTIME 2400 at the day's end", () => {
    const r = cleanDemandForecast214d([row("2026-11-18", 30, "2026-11-18T00:30:00"), row("2026-11-18", 2400, "2026-11-19T00:00:00", 25000)]);
    expect(r.dropped).toBe(0);
    expect(r.observations).toEqual([
      { region: "gb", validFrom: Z("2026-11-18T00:00:00"), value: 27045, quality: "ok", rawValue: null },
      { region: "gb", validFrom: Z("2026-11-18T23:30:00"), value: 25000, quality: "ok", rawValue: null },
    ]);
    expect(DEMAND_FORECAST_2_14D.regions).toEqual(["gb"]);
  });

  it("in BST, accepts a UTC end label that shows the local end on a UK clock", () => {
    const r = cleanDemandForecast214d([row("2026-07-01", 30, "2026-06-30T23:30:00")]);
    expect(starts(r)).toEqual([Z("2026-06-30T23:00:00")]);
  });

  it("in BST, drops a row whose end label is local time: stop, rather than store it an hour out", () => {
    const r = cleanDemandForecast214d([row("2026-07-01", 30, "2026-07-01T00:30:00")]);
    expect(r.dropped).toBe(1);
  });

  it("keeps both 01:30s on the autumn change, an hour apart in UTC", () => {
    const r = cleanDemandForecast214d([row("2026-10-25", 130, "2026-10-25T00:30:00"), row("2026-10-25", 130, "2026-10-25T01:30:00")]);
    expect(r.dropped).toBe(0);
    expect(starts(r)).toEqual([Z("2026-10-25T00:00:00"), Z("2026-10-25T01:00:00")]);
  });

  it("drops impossible clock times", () => {
    const bad = [0, 45, 2430, 2500, -30, 99, "x", null];
    const r = cleanDemandForecast214d(bad.map((c) => row("2026-11-18", c, "2026-11-18T00:30:00")));
    expect(r.dropped).toBe(bad.length);
  });

  it("rejects a demand of zero or far beyond GB's peak", () => {
    const r = cleanDemandForecast214d([row("2026-11-18", 30, "2026-11-18T00:30:00", 0), row("2026-11-18", 100, "2026-11-18T01:00:00", 270_450)]);
    expect(r.observations.map((o) => o.quality)).toEqual(["rejected", "rejected"]);
  });
});
