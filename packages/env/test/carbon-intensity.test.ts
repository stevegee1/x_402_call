import { describe, expect, it } from "vitest";
import { CARBON_INTENSITY, cleanCarbonIntensity } from "../src";

const T = Date.parse("2026-11-07T14:00:00Z");
const rec = (datetime: unknown, England: unknown = 200, Scotland: unknown = 30, Wales: unknown = 300) => ({ _id: 1, datetime, England, Scotland, Wales });

describe("cleanCarbonIntensity", () => {
  it("turns each row into one observation per region, in UTC, sorted by period", () => {
    const r = cleanCarbonIntensity([rec("2026-11-07T14:30:00", 201, 31, 301), rec("2026-11-07T14:00:00")]);
    expect(r.dropped).toBe(0);
    expect(r.duplicates).toBe(0);
    expect(r.observations).toEqual([
      { region: "england", validFrom: T, value: 200, quality: "ok", rawValue: null },
      { region: "scotland", validFrom: T, value: 30, quality: "ok", rawValue: null },
      { region: "wales", validFrom: T, value: 300, quality: "ok", rawValue: null },
      { region: "england", validFrom: T + 1_800_000, value: 201, quality: "ok", rawValue: null },
      { region: "scotland", validFrom: T + 1_800_000, value: 31, quality: "ok", rawValue: null },
      { region: "wales", validFrom: T + 1_800_000, value: 301, quality: "ok", rawValue: null },
    ]);
  });

  it("reads datetimes as UTC, with or without seconds", () => {
    const r = cleanCarbonIntensity([rec("2026-11-07T14:00")]);
    expect(r.observations[0]!.validFrom).toBe(T);
  });

  it("accepts numeric strings and the range bounds", () => {
    const r = cleanCarbonIntensity([rec("2026-11-07T14:00:00", "0", 2000, "123.5")]);
    expect(r.observations.map((o) => o.value)).toEqual([0, 2000, 123.5]);
    expect(r.observations.every((o) => o.quality === "ok")).toBe(true);
  });

  it("flags a missing value as missing and never fills it in", () => {
    const r = cleanCarbonIntensity([{ datetime: "2026-11-07T14:00:00", England: null, Wales: "" }]); // Scotland absent
    expect(r.observations).toHaveLength(3);
    for (const o of r.observations) expect(o).toMatchObject({ value: null, quality: "missing", rawValue: null });
  });

  it("flags implausible values as rejected and keeps the raw value for audit", () => {
    const r = cleanCarbonIntensity([rec("2026-11-07T14:00:00", -1, 2000.5, "n/a"), rec("2026-11-07T14:30:00", true, { v: 1 }, Number.NaN)]);
    expect(r.observations.map((o) => [o.quality, o.value, o.rawValue])).toEqual([
      ["rejected", null, "-1"],
      ["rejected", null, "2000.5"],
      ["rejected", null, "n/a"],
      ["rejected", null, "true"],
      ["rejected", null, '{"v":1}'],
      ["rejected", null, "null"], // JSON has no NaN
    ]);
  });

  it("drops rows it cannot place: bad or offset datetimes, misaligned periods, non-objects", () => {
    const r = cleanCarbonIntensity([
      null,
      "row",
      42,
      rec(undefined),
      rec("2026-11-07"),
      rec("2026-11-07T14:00:00Z"), // NESO sends naive UTC; an explicit zone is a format change
      rec("2026-11-07T14:15:00"), // not on a half-hour
      rec("2026-11-07T14:00:01"),
      rec("2026-13-40T14:00:00"),
      rec("2026-11-07T14:00:00"),
    ]);
    expect(r.dropped).toBe(9);
    expect(r.observations).toHaveLength(3);
  });

  it("keeps the last of several rows for one period and counts the repeats", () => {
    const r = cleanCarbonIntensity([rec("2026-11-07T14:00:00", 1), rec("2026-11-07T14:00:00", 2), rec("2026-11-07T14:00:00", 3)]);
    expect(r.duplicates).toBe(2);
    expect(r.observations.find((o) => o.region === "england")!.value).toBe(3);
  });

  it("handles an empty fetch", () => {
    expect(cleanCarbonIntensity([])).toEqual({ observations: [], dropped: 0, duplicates: 0 });
  });

  it("is wired into the dataset spec with a stable id", () => {
    expect(CARBON_INTENSITY).toMatchObject({ id: "neso.carbon_intensity", unit: "gCO2/kWh", periodMs: 1_800_000, regions: ["england", "scotland", "wales"] });
    expect(CARBON_INTENSITY.clean).toBe(cleanCarbonIntensity);
  });
});
