import { makeCleaner } from "../clean";
import { HALF_HOUR_MS, intOf, parseNaiveUtc, settlementPeriodStart } from "../time";
import type { DatasetSpec } from "../types";

/**
 * Elexon prices, £/MWh per GB settlement period. Placement: settlementDate + settlementPeriod give
 * the period; `startTime` (UTC) must agree, or the row is dropped.
 */
function elexonPeriodStart(rec: Record<string, unknown>): number | null {
  const date = typeof rec.settlementDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rec.settlementDate) ? rec.settlementDate : null;
  const sp = intOf(rec.settlementPeriod);
  if (date === null || sp === null) return null;
  const start = settlementPeriodStart(date, sp);
  const label = typeof rec.startTime === "string" && rec.startTime.endsWith("Z") ? parseNaiveUtc(rec.startTime.slice(0, -1)) : null;
  return start !== null && label === start ? start : null;
}

/** Wholesale and imbalance prices have gone below −£1,000 and above £4,000/MWh: outside ±£10,000 is an error. */
const PRICE = { min: -10_000, max: 10_000 };

/**
 * System prices (the imbalance price): system sell and system buy price per period. Elexon revises
 * them through the settlement runs, so each version is kept. Two settlement dates are read each
 * time (today and yesterday).
 */
export const cleanSystemPrices = makeCleaner({
  periodMs: HALF_HOUR_MS,
  periodStart: elexonPeriodStart,
  columns: [
    { region: "ssp", field: "systemSellPrice", ...PRICE },
    { region: "sbp", field: "systemBuyPrice", ...PRICE },
  ],
});

export const ELEXON_SYSTEM_PRICES: DatasetSpec = {
  id: "elexon.system_prices",
  unit: "GBP/MWh",
  periodMs: HALF_HOUR_MS,
  regions: ["ssp", "sbp"],
  source: "elexon",
  resourceId: "/balancing/settlement/system-prices/{date}?format=json",
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  minFetchIntervalMs: 5 * 60_000,
  clean: cleanSystemPrices,
};

/**
 * Market Index Data: the wholesale market index price per period from APX (APXMIDP), the provider
 * that trades (N2EXMIDP reported no trades in any period checked on 2026-11-17, so it isn't
 * followed). A period with no trades reports price 0 and volume 0: stored as missing, never as a
 * price of zero.
 */
const cleanApx = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: elexonPeriodStart, columns: [{ region: "apx", field: "apxPrice", ...PRICE }] });
export function cleanMarketIndex(records: readonly unknown[]) {
  const apx = records.filter((r) => !r || typeof r !== "object" || Array.isArray(r) || (r as Record<string, unknown>).dataProvider === "APXMIDP");
  return cleanApx(
    apx.map((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return r;
      const rec = r as Record<string, unknown>;
      return { ...rec, apxPrice: rec.price === 0 && rec.volume === 0 ? null : rec.price };
    }),
  );
}

export const ELEXON_MARKET_INDEX: DatasetSpec = {
  id: "elexon.market_index",
  unit: "GBP/MWh",
  periodMs: HALF_HOUR_MS,
  regions: ["apx"],
  source: "elexon",
  resourceId: "/datasets/MID?from={from}&to={to}&format=json",
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  minFetchIntervalMs: 5 * 60_000,
  clean: cleanMarketIndex,
};
