import { makeCleaner } from "../clean";
import { HALF_HOUR_MS, parseNaiveUtc } from "../time";
import type { DatasetSpec } from "../types";

/**
 * NESO Historic GB Generation Mix: estimated outturn MW by fuel, half-hourly. Rows are keyed by
 * `DATETIME` and updated in place (`datastore_append_or_update`), so revised estimates replace the
 * first ones upstream. We keep each version.
 *
 * `DATETIME` is the period start in naive UTC. Checked 2026-11-16: on the 2026-10-25 clock change
 * it has one 01:00 and one 01:30 (UTC, not local), and its solar on 2026-07-01 matches NESO's
 * settlement-period solar forecast best with no shift (mean error 204 MW, against 418 and 568 MW
 * shifted half an hour either way).
 *
 * We take the MW columns only. The `_perc` columns are derived from them, and CARBON_INTENSITY is
 * in another unit (a dataset has one unit).
 */
const FIELDS: ReadonlyArray<[string, string]> = [
  ["gas", "GAS"],
  ["coal", "COAL"],
  ["nuclear", "NUCLEAR"],
  ["wind", "WIND"],
  ["wind_embedded", "WIND_EMB"],
  ["hydro", "HYDRO"],
  ["imports", "IMPORTS"],
  ["biomass", "BIOMASS"],
  ["other", "OTHER"],
  ["solar", "SOLAR"],
  ["storage", "STORAGE"],
  ["generation", "GENERATION"],
];
// Every column has been >= 0 since 2024 (imports and storage are reported as gross, not net). GB
// total generation peaks near 55 GW, so 100 GW is far beyond any real value of any column.
const COLUMNS = FIELDS.map(([region, field]) => ({ region, field, min: 0, max: 100_000 }));

export const cleanGenerationMix = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: (r) => parseNaiveUtc(r.DATETIME), columns: COLUMNS });

export const GENERATION_MIX: DatasetSpec = {
  id: "neso.generation_mix",
  unit: "MW",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "f93d1835-75bc-43e5-84ad-12472b180a98",
  sort: "DATETIME desc",
  // ~30 days. Upstream can lag by days and NESO's daily updates touch older rows, so a short window
  // would never version revisions further back. Only changed values are stored, so this costs reads, not rows.
  fetchLimit: 1_440,
  wholeResource: false,
  clean: cleanGenerationMix,
};
