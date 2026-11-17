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
