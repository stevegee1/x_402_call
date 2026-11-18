import { describe, expect, it } from "vitest";
import { REGIONAL_CARBON_INTENSITY, SITES } from "../src";

describe("UK data-centre sites", () => {
  it("has unique, stable ids and complete entries with a public source", () => {
    expect(new Set(SITES.map((s) => s.id)).size).toBe(SITES.length);
    for (const s of SITES) {
      expect(s.id, s.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(s.postcode, s.id).toMatch(/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/);
      expect(s.source, s.id).toMatch(/^https:\/\//);
    }
  });

  it("places every site in Great Britain, in a grid region we record", () => {
    for (const s of SITES) {
      expect(s.lat, s.id).toBeGreaterThan(49.8);
      expect(s.lat, s.id).toBeLessThan(60.9);
      expect(s.lon, s.id).toBeGreaterThan(-8.7);
      expect(s.lon, s.id).toBeLessThan(1.8);
      expect(REGIONAL_CARBON_INTENSITY.regions, s.id).toContain(s.gridRegion);
    }
  });
});

import { SITE_FLOOD_AREAS, SITE_FLOOD_SERIES, floodSeries } from "../src";
describe("site flood areas", () => {
  it("every site has its EA flood areas, named as ea.flood_warnings stores them", () => {
    for (const s of SITES) expect(SITE_FLOOD_AREAS[s.id]?.length, s.id).toBeGreaterThan(0);
    expect(Object.keys(SITE_FLOOD_AREAS).sort()).toEqual(SITES.map((s) => s.id).sort());
    expect(floodSeries("063FWT23IoDA")).toBe("fa_063fwt23ioda");
    expect(SITE_FLOOD_SERIES.every((s) => /^fa_[0-9a-z]{3,32}$/.test(s))).toBe(true);
  });
});
