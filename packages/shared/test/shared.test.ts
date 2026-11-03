import { describe, expect, it } from "vitest";
import { inPolygon, haversineM, regionForPoint, REGIONS, usdToUsdcAtomic } from "../src";

describe("geo", () => {
  it("point in polygon", () => {
    const poly = REGIONS.dover.anchorages[0]!.polygon;
    expect(inPolygon(1.47, 51.23, poly)).toBe(true);
    expect(inPolygon(1.3, 51.23, poly)).toBe(false);
  });

  it("haversine Dover-Calais is ~40km", () => {
    const d = haversineM(51.1279, 1.3134, 50.9513, 1.8587);
    expect(d).toBeGreaterThan(38_000);
    expect(d).toBeLessThan(44_000);
  });

  it("assigns regions by bbox", () => {
    expect(regionForPoint(1.5, 51.0)).toBe("dover");
    expect(regionForPoint(4.0, 51.95)).toBe("rotterdam");
    expect(regionForPoint(-79.9, 9.35)).toBe("panama");
    expect(regionForPoint(0, 0)).toBeUndefined();
  });
});

describe("pricing", () => {
  it("converts USD to USDC atomic exactly", () => {
    expect(usdToUsdcAtomic("0.033")).toBe(33_000n);
    expect(usdToUsdcAtomic("0.066")).toBe(66_000n);
    expect(usdToUsdcAtomic("12")).toBe(12_000_000n);
    expect(() => usdToUsdcAtomic("0.0000001")).toThrow();
  });
});
