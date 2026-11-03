/**
 * NESO "Country Carbon Intensity Forecast" (Data Portal, NESO Open Data Licence, which permits
 * commercial use with attribution). Half-hourly forecast in gCO2/kWh for England, Scotland and
 * Wales, about 48 hours ahead.
 *
 * Deliberately NOT the carbonintensity.org.uk API: its terms forbid selling access to it. And not
 * the regional dataset: it stopped updating on 2026-07-24 (checked 2026-11-03).
 */
export const COUNTRIES = ["england", "scotland", "wales"] as const;
export type Country = (typeof COUNTRIES)[number];
export const isCountry = (v: string): v is Country => (COUNTRIES as readonly string[]).includes(v);

const COLUMN: Record<Country, string> = { england: "England", scotland: "Scotland", wales: "Wales" };

export const NESO_COUNTRY_RESOURCE_ID = "e032e7aa-dea5-4695-80d6-19739142021d";
export const SOURCE = {
  name: "NESO Country Carbon Intensity Forecast",
  dataset: "https://www.neso.energy/data-portal/country-carbon-intensity-forecast",
  licence: "NESO Open Data Licence",
  /** Wording required by the licence. */
  attribution: "Supported by National Energy SO Open Data",
  disclaimer: "Forecast supplied as is. This service is not provided or endorsed by NESO.",
} as const;

export const PERIOD_MS = 30 * 60_000;

/** One half-hour; `start` is the period start as NESO labels it (UTC). null = no value published. */
export interface HalfHour {
  start: number;
  values: Record<Country, number | null>;
}

export interface GridSource {
  fetch(): Promise<HalfHour[]>;
}

const plausible = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 2_000 ? n : null;
};

/** Parses CKAN datastore records; drops malformed rows, sorts ascending, de-duplicates by start. */
export function parseRecords(records: unknown[]): HalfHour[] {
  const byStart = new Map<number, HalfHour>();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const raw = (r as Record<string, unknown>).datetime;
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) continue;
    const start = Date.parse(`${raw}Z`);
    if (!Number.isFinite(start) || start % PERIOD_MS !== 0) continue;
    const values = Object.fromEntries(COUNTRIES.map((c) => [c, plausible((r as Record<string, unknown>)[COLUMN[c]])])) as HalfHour["values"];
    byStart.set(start, { start, values });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** Reads the newest rows from the NESO Data Portal (CKAN datastore_search). */
export class NesoGridSource implements GridSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async fetch(): Promise<HalfHour[]> {
    const u = new URL("/api/3/action/datastore_search", this.baseUrl);
    u.searchParams.set("resource_id", NESO_COUNTRY_RESOURCE_ID);
    u.searchParams.set("sort", "datetime desc");
    u.searchParams.set("limit", "200"); // ~100 h: the whole forward horizon plus recent history
    const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`NESO datastore ${res.status}`);
    const body = (await res.json()) as { success?: boolean; result?: { records?: unknown[] } };
    if (!body.success || !Array.isArray(body.result?.records)) throw new Error("NESO datastore: unexpected response");
    return parseRecords(body.result.records);
  }
}
