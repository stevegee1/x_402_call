import { OBSERVED_AT } from "../ea";
import type { CleanResult, DatasetSpec, Observation } from "../types";

/**
 * Environment Agency flood warnings in force in England, sampled every 15 minutes.
 *
 * The source lists only the warnings in force now (severity 1 severe flood warning, 2 flood warning,
 * 3 flood alert, 4 no longer in force, kept about 24 h after it ends). It keeps no history, so each
 * fetch is stored as the state of every listed flood area for the 15-minute period it was observed
 * in: a point-in-time record of which warnings were in force, and how severe, at any moment.
 *
 * Series ("region") = `fa_` + the flood area id, lowercased. An area absent from a fetch has no
 * warning in force (absence is stored as nothing, as for every dataset). The required attribution
 * is EA_ATTRIBUTION.
 */
export const FLOOD_PERIOD_MS = 15 * 60_000;
const AREA = /^[0-9A-Za-z]{3,32}$/;

export function cleanFloodWarnings(records: readonly unknown[]): CleanResult {
  const byArea = new Map<string, Observation>();
  let dropped = 0;
  let duplicates = 0;
  for (const r of records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      dropped++;
      continue;
    }
    const rec = r as Record<string, unknown>;
    const observed = rec[OBSERVED_AT];
    const area = rec.floodAreaID;
    const level = rec.severityLevel;
    if (typeof observed !== "number" || !Number.isFinite(observed) || typeof area !== "string" || !AREA.test(area)) {
      dropped++;
      continue;
    }
    const region = `fa_${area.toLowerCase()}`;
    const validFrom = Math.floor(observed / FLOOD_PERIOD_MS) * FLOOD_PERIOD_MS;
    const ok = typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 4;
    const obs: Observation = ok
      ? { region, validFrom, value: level, quality: "ok", rawValue: null }
      : level === null || level === undefined
        ? { region, validFrom, value: null, quality: "missing", rawValue: null }
        : { region, validFrom, value: null, quality: "rejected", rawValue: typeof level === "string" ? level : (JSON.stringify(level) ?? String(level)) };
    const prev = byArea.get(region);
    if (prev) {
      duplicates++;
      // Two warnings listed for one area: keep the most severe (lowest level); a bad value never wins.
      if (prev.quality === "ok" && (obs.quality !== "ok" || prev.value! <= obs.value!)) continue;
    }
    byArea.set(region, obs);
  }
  const observations = [...byArea.values()].sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  return { observations, dropped, duplicates };
}

export const EA_FLOOD_WARNINGS: DatasetSpec = {
  id: "ea.flood_warnings",
  unit: "severity",
  periodMs: FLOOD_PERIOD_MS,
  regions: [], // open set: flood areas appear as warnings are raised
  source: "ea",
  resourceId: "/flood-monitoring/id/floods",
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  emptyIsNormal: true,
  clean: cleanFloodWarnings,
};
