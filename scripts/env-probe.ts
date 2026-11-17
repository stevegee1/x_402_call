/**
 * Live conformance check for every ingest-env dataset: reads the real NESO resources the way the
 * poller does (same client, sort, limit and cleaner) and checks the result. Read-only, writes
 * nothing. This is the periodic eval for the cleaners: unit tests pin the rules, this proves the
 * rules still match what NESO actually publishes.
 *
 *   pnpm env:probe              # exits 1 if any dataset fails a hard check
 *   pnpm env:probe neso.generation_mix
 *
 * Hard checks (fail): the fetch works, every row is placed (0 dropped), a whole-run fetch isn't
 * cut, at least 99% of values are ok, and a forecast still reaches far enough ahead.
 * Soft check (warn): the newest period isn't older than expected (generation mix lags upstream).
 */
import { type DatasetSpec, EaClient, ElexonClient, ENV_DATASETS, NesoClient } from "../packages/env/src";

const HOUR = 3_600_000;
/** How far ahead each forecast must reach (hard), or how recent the newest period must be (soft). */
const EXPECT: Record<string, { aheadH?: number; staleH?: number }> = {
  "neso.carbon_intensity": { aheadH: 12 },
  "neso.regional_carbon_intensity": { aheadH: 12 },
  "neso.embedded_wind_solar_forecast": { aheadH: 7 * 24 },
  "neso.wind_forecast_14d": { aheadH: 7 * 24 },
  "neso.demand_forecast_2_14d": { aheadH: 7 * 24 },
  "neso.generation_mix": { staleH: 48 },
  "ea.flood_warnings": { staleH: 1 },
};

const only = process.argv.slice(2);
const datasets = only.length ? ENV_DATASETS.filter((d) => only.includes(d.id)) : ENV_DATASETS;
const ea = new EaClient({ baseUrl: process.env.EA_BASE_URL ?? "https://environment.data.gov.uk", timeoutMs: 30_000 });
const client = new NesoClient({ baseUrl: process.env.NESO_BASE_URL ?? "https://api.neso.energy", minIntervalMs: 1_100, timeoutMs: 30_000 });
const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) : "-");

async function probe(d: DatasetSpec): Promise<{ fails: string[]; warns: string[]; line: string }> {
  const fails: string[] = [];
  const warns: string[] = [];
  const src = d.source === "ea" ? ea : d.source === "elexon" ? new ElexonClient({ baseUrl: "https://data.elexon.co.uk", timeoutMs: 30_000 }) : client;
  const modified = await src.lastModified(d.resourceId);
  const records = await src.records(d.resourceId, d.fetchLimit, d.sort);
  const r = d.clean(records);
  const now = Date.now();
  const n = r.observations.length;
  const ok = r.observations.filter((o) => o.quality === "ok");
  const starts = r.observations.map((o) => o.validFrom);
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  const missingNow = r.observations.filter((o) => o.quality !== "ok" && o.validFrom <= now + 24 * HOUR).length;

  if ((records.length === 0 || n === 0) && !d.emptyIsNormal) fails.push("no rows");
  if (r.dropped > 0) fails.push(`${r.dropped}/${records.length} rows could not be placed`);
  if (d.wholeResource && records.length >= d.fetchLimit) fails.push(`fetch filled its limit (${d.fetchLimit}): horizon cut`);
  // Only the next 24 h count: placeholder rows far ahead may legitimately be empty.
  if (missingNow > 0.01 * n) fails.push(`${missingNow} values in the next 24 h are not ok`);
  const e = EXPECT[d.id] ?? {};
  if (e.aheadH !== undefined && last < now + e.aheadH * HOUR) fails.push(`horizon ends ${iso(last)}, want ≥ ${e.aheadH} h ahead`);
  if (e.staleH !== undefined && n > 0 && last < now - e.staleH * HOUR) warns.push(`newest period ${iso(last)} is ${Math.round((now - last) / HOUR)} h old (upstream lag)`);
  if (r.duplicates > 0) warns.push(`${r.duplicates} repeated periods`);
  for (const region of d.regions) if (!r.observations.some((o) => o.region === region && o.quality === "ok")) fails.push(`series ${region} has no ok value`);

  const line = `${d.id.padEnd(36)} rows=${String(records.length).padStart(4)} obs=${String(n).padStart(5)} ok=${((100 * ok.length) / Math.max(n, 1)).toFixed(1)}% periods=${iso(first)}..${iso(last)} published=${modified ? iso(modified) : "-"}`;
  return { fails, warns, line };
}

let failed = 0;
for (const d of datasets) {
  try {
    const { fails, warns, line } = await probe(d);
    console.log(`${fails.length ? "FAIL" : "ok  "} ${line}`);
    for (const f of fails) console.log(`       fail: ${f}`);
    for (const w of warns) console.log(`       warn: ${w}`);
    if (fails.length) failed++;
  } catch (e) {
    failed++;
    console.log(`FAIL ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(failed ? `${failed} of ${datasets.length} datasets failed` : `all ${datasets.length} datasets pass`);
process.exitCode = failed ? 1 : 0;
