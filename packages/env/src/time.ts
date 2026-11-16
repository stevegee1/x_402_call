/**
 * Time helpers for NESO data. NESO labels periods three ways: naive UTC timestamps, GB settlement
 * periods (numbered half-hours of the UK local day), and UK local wall-clock times. Everything we
 * store is UTC, so each label is converted here, and anything that doesn't convert exactly is
 * rejected (null) rather than guessed.
 */

export const HALF_HOUR_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

const london = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function londonParts(t: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of london.formatToParts(t)) out[p.type] = p.value;
  return out;
}

/** UK local wall-clock time of an instant, as "YYYY-MM-DDTHH:MM". */
export function londonWallClock(t: number): string {
  const p = londonParts(t);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** UK local time minus UTC at an instant, in ms: 0 in winter (GMT), 3,600,000 in summer (BST). */
export function londonOffsetMs(t: number): number {
  const p = londonParts(t);
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - Math.floor(t / 1000) * 1000;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms of 00:00 UTC on a calendar date "YYYY-MM-DD", or null if it isn't a real date. */
function utcMidnight(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  // Date.UTC rolls over (Feb 30 → Mar 2); a real date survives the round trip.
  return new Date(t).toISOString().slice(0, 10) === date ? t : null;
}

/**
 * When a GB settlement day starts (UK local midnight), in epoch ms UTC. UK clocks change at
 * 01:00 UTC, so local midnight is never ambiguous, and the offset at 00:00 UTC on the same date is
 * the offset in force at local midnight.
 */
export function settlementDayStart(date: string): number | null {
  const hit = dayStarts.get(date);
  if (hit !== undefined) return hit;
  const u = utcMidnight(date);
  const start = u === null ? null : u - londonOffsetMs(u);
  // Each fetch places hundreds of rows over a dozen days; the timezone lookup is the slow part.
  if (dayStarts.size >= 4_096) dayStarts.clear();
  dayStarts.set(date, start);
  return start;
}
const dayStarts = new Map<string, number | null>();

/** How many half-hour settlement periods a day has: 48, or 46 / 50 on clock-change days. */
export function settlementPeriods(date: string): number | null {
  const start = settlementDayStart(date);
  const u = utcMidnight(date);
  if (start === null || u === null) return null;
  const next = settlementDayStart(new Date(u + DAY_MS).toISOString().slice(0, 10));
  return next === null ? null : (next - start) / HALF_HOUR_MS;
}

/** Start of settlement period `period` (1-based) on `date`, in epoch ms UTC, or null if it doesn't exist. */
export function settlementPeriodStart(date: string, period: number): number | null {
  if (!Number.isInteger(period) || period < 1) return null;
  const n = settlementPeriods(date);
  if (n === null || period > n) return null;
  return settlementDayStart(date)! + (period - 1) * HALF_HOUR_MS;
}

const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * A naive timestamp ("2026-11-07T14:00" or with ":00" seconds) read as UTC, or null. A timestamp
 * with a zone is refused: NESO sends naive values, so a zone would mean the format changed.
 */
export function parseNaiveUtc(v: unknown): number | null {
  if (typeof v !== "string" || !NAIVE.test(v)) return null;
  const t = Date.parse(`${v}Z`);
  if (!Number.isFinite(t)) return null;
  // Reject rolled-over dates and times (Feb 30, 24:00) instead of silently moving them.
  return new Date(t).toISOString().slice(0, 16) === v.slice(0, 16) ? t : null;
}

/** The calendar date of a date-only value ("2026-11-16" or "2026-11-16T00:00:00"), or null. */
export function datePart(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})(T00:00(:00)?)?$/.exec(v);
  return m && utcMidnight(m[1]!) !== null ? m[1]! : null;
}

/** A whole number from a number or a numeric string, or null. */
export function intOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** The calendar date `days` after `date` ("YYYY-MM-DD"). */
export function addDays(date: string, days: number): string | null {
  const u = utcMidnight(date);
  return u === null ? null : new Date(u + days * DAY_MS).toISOString().slice(0, 10);
}
