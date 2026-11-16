import { REGIONS } from "@mx/shared";
import { describe, expect, it } from "vitest";
import { BASE_URL, createTestEnv } from "../../helpers";
import { maritimeDescription } from "../../../src/products/maritime";

describe("maritime description", () => {
  it("claims only live regions as coverage and labels the rest beta, from the region config", () => {
    expect(maritimeDescription()).toBe(
      "AIS vessel data and derived signals (density, anchorage queues, anomalies) for the Dover Strait, with the Port of Rotterdam approaches and Panama Canal approaches in beta. Beta regions depend on AIS reception and may have no data; calls are never charged when they don't.",
    );
  });

  it("reads naturally for any mix of live and beta regions", () => {
    const { dover, rotterdam, panama } = REGIONS;
    expect(maritimeDescription([dover, { ...rotterdam, status: "live" }])).toBe(
      "AIS vessel data and derived signals (density, anchorage queues, anomalies) for the Dover Strait and Port of Rotterdam approaches.",
    );
    expect(maritimeDescription([{ ...dover, status: "beta" }, panama])).toMatch(/^AIS vessel data .*, in beta for the Dover Strait and Panama Canal approaches\. /);
  });

  it("is what the API and pages publish for maritime", async () => {
    const env = await createTestEnv({});
    const products = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    const maritime = products.data.find((p: { id: string }) => p.id === "maritime");
    expect(maritime.description).toBe(maritimeDescription());
    expect(maritime.description).toContain("in beta");
  });
});
