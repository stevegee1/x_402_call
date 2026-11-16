import { describe, expect, it } from "vitest";
import { NESO_DATASETS } from "@mx/env";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x@localhost/db" };

describe("loadConfig", () => {
  it("applies production-safe defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      NESO_BASE_URL: "https://api.neso.energy",
      ENV_CHECK_INTERVAL_MS: 30_000,
      ENV_MAX_FETCH_INTERVAL_MS: 600_000,
      ENV_MAX_BACKOFF_MS: 300_000,
      ENV_HTTP_TIMEOUT_MS: 10_000,
      ENV_PUBLISH_SETTLE_MS: 300_000,
      ENV_HEALTH_PORT: 8091,
    });
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("refuses plain http to the source in production, and allows it elsewhere", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", NESO_BASE_URL: "http://neso.test" })).toThrow(/NESO_BASE_URL: must be https/);
    expect(loadConfig({ ...base, NESO_BASE_URL: "http://127.0.0.1:9999" }).NESO_BASE_URL).toBe("http://127.0.0.1:9999");
  });

  it("enforces a floor on the check interval so we never hammer the source", () => {
    expect(() => loadConfig({ ...base, ENV_CHECK_INTERVAL_MS: "1000" })).toThrow(/ENV_CHECK_INTERVAL_MS/);
    expect(loadConfig({ ...base, ENV_CHECK_INTERVAL_MS: "5000" }).ENV_CHECK_INTERVAL_MS).toBe(5_000);
  });

  it("rejects intervals that contradict each other", () => {
    expect(() => loadConfig({ ...base, ENV_CHECK_INTERVAL_MS: "120000", ENV_MAX_FETCH_INTERVAL_MS: "60000" })).toThrow(/ENV_MAX_FETCH_INTERVAL_MS/);
    expect(() => loadConfig({ ...base, ENV_CHECK_INTERVAL_MS: "120000", ENV_MAX_BACKOFF_MS: "60000" })).toThrow(/ENV_MAX_BACKOFF_MS/);
  });

  it("rejects non-numeric and out-of-range values", () => {
    expect(() => loadConfig({ ...base, ENV_HEALTH_PORT: "abc" })).toThrow(/ENV_HEALTH_PORT/);
    expect(() => loadConfig({ ...base, ENV_HEALTH_PORT: "70000" })).toThrow(/ENV_HEALTH_PORT/);
    expect(() => loadConfig({ ...base, ENV_HTTP_TIMEOUT_MS: "1.5" })).toThrow(/ENV_HTTP_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, NESO_BASE_URL: "not a url" })).toThrow(/NESO_BASE_URL/);
  });

  it("polls every dataset by default, with a 10% margin under NESO's 1 request a second", async () => {
    const { selectedDatasets } = await import("../src/config");
    const c = loadConfig(base);
    expect(c.ENV_MIN_REQUEST_GAP_MS).toBe(1_100);
    expect(selectedDatasets(c).map((d) => d.id)).toEqual(NESO_DATASETS.map((d) => d.id));
  });

  it("polls a named subset, in registry order, and refuses unknown or empty lists", async () => {
    const { selectedDatasets } = await import("../src/config");
    const c = loadConfig({ ...base, ENV_DATASETS: " neso.generation_mix , neso.carbon_intensity " });
    expect(selectedDatasets(c).map((d) => d.id)).toEqual(["neso.carbon_intensity", "neso.generation_mix"]);
    expect(() => loadConfig({ ...base, ENV_DATASETS: "neso.carbon_intensity,neso.typo" })).toThrow(/ENV_DATASETS: unknown dataset neso.typo/);
    expect(() => loadConfig({ ...base, ENV_DATASETS: " , " })).toThrow(/ENV_DATASETS/);
  });

  it("refuses a request gap below NESO's limit", () => {
    expect(() => loadConfig({ ...base, ENV_MIN_REQUEST_GAP_MS: "1000" })).toThrow(/ENV_MIN_REQUEST_GAP_MS/);
    expect(loadConfig({ ...base, ENV_MIN_REQUEST_GAP_MS: "1050" }).ENV_MIN_REQUEST_GAP_MS).toBe(1_050);
  });
});
