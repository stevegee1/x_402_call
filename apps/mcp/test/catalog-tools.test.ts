import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { buildPath, buildTools, trimForModel, type CatalogProduct } from "../src/catalog-tools";

const catalog = (JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")) as { data: CatalogProduct[] }).data;
const tools = buildTools(catalog);
const tool = (name: string) => tools.find((t) => t.name === name)!;
const parse = (name: string, args: unknown) => z.object(tool(name).inputSchema).safeParse(args);

describe("tools generated from the gateway catalog", () => {
  it("one tool per data endpoint, every product; streams and session purchases are not data tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["grid_countries", "grid_forecast", "grid_history", "grid_intensity", "grid_revisions", "grid_window", "maritime_anomalies", "maritime_density", "maritime_queue", "maritime_regions", "maritime_vessel", "maritime_vessels"].sort(),
    );
  });

  it("descriptions carry the live prices from the catalog", () => {
    expect(tool("grid_intensity").description).toMatch(/^Paid: 0\.012 USDC \(x402\), £0\.01 \(credits\), 0\.012 USDC from a session\./);
    expect(tool("maritime_regions").description).toMatch(/^Free\./);
  });

  it("validates arguments from the endpoint's parameters", () => {
    expect(parse("grid_intensity", { country: "wales" }).success).toBe(true);
    expect(parse("grid_intensity", { country: "france" }).success).toBe(false); // enum
    expect(parse("grid_intensity", {}).success).toBe(false); // path param required
    expect(parse("grid_window", { country: "england" }).success).toBe(false); // required query param
    expect(parse("grid_window", { country: "england", duration_h: 0.1 }).success).toBe(false); // minimum
    expect(parse("grid_window", { country: "england", duration_h: 2 }).success).toBe(true);
    expect(parse("maritime_vessel", { region: "dover", mmsi: 1.5 }).success).toBe(false); // integer
  });

  it("builds the request path: path parameters filled and encoded, optional query only when given", () => {
    expect(tool("grid_window").path({ country: "england", duration_h: 2 })).toBe("/v1/grid/england/window?duration_h=2");
    expect(tool("grid_forecast").path({ country: "wales" })).toBe("/v1/grid/wales/forecast");
    expect(tool("grid_history").path({ country: "scotland", from: "2026-11-07T00:00:00Z" })).toBe("/v1/grid/scotland/history?from=2026-11-07T00%3A00%3A00Z");
    expect(() => buildPath(tool("grid_intensity").endpoint, {})).toThrow(/missing path parameter country/);
    expect(tool("maritime_vessel").path({ region: "a/b", mmsi: 1 })).toBe("/v1/maritime/a%2Fb/vessels/1");
  });

  it("keeps results small enough for a model", () => {
    const big = { mode: "live", data: Array.from({ length: 120 }, (_, i) => i) };
    expect(trimForModel(big, 50)).toMatchObject({ truncated: true, returned: 50, total: 120 });
    expect((trimForModel(big, 50) as { data: number[] }).data).toHaveLength(50);
    expect(trimForModel({ data: [1, 2] }, 50)).toEqual({ data: [1, 2] });
  });
});
