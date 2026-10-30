import { regionForPoint, type AisEvent, type DataMode } from "@mx/shared";
import { decodePayload, isPosition, type AisMessage } from "./decode";
import { FragmentAssembler, parseSentence } from "./nmea";

export interface SourceContext {
  source: string;
  mode: DataMode;
  receiverId?: string;
}

/** Decoded message -> bus event. Positions outside every region are dropped. */
export function toEvent(msg: AisMessage, ts: number, ctx: SourceContext): AisEvent | null {
  if (isPosition(msg)) {
    if (msg.lat === undefined || msg.lon === undefined) return null;
    const region = regionForPoint(msg.lon, msg.lat);
    if (!region) return null;
    return {
      kind: "position",
      region,
      data: {
        mmsi: msg.mmsi,
        lat: msg.lat,
        lon: msg.lon,
        sog: msg.sog,
        cog: msg.cog,
        heading: msg.heading,
        navStatus: msg.navStatus,
        ts,
        source: ctx.source,
        mode: ctx.mode,
        receiverId: ctx.receiverId,
      },
    };
  }
  return {
    kind: "static",
    data: {
      mmsi: msg.mmsi,
      imo: msg.imo,
      name: msg.name,
      callsign: msg.callsign,
      shipType: msg.shipType,
      lengthM: msg.lengthM,
      beamM: msg.beamM,
      draughtM: msg.draughtM,
      destination: msg.destination,
      ts,
      source: ctx.source,
    },
  };
}

/** Stateful line -> event pipeline for raw NMEA feeds (own receivers via AIS-catcher, etc). */
export class NmeaPipeline {
  private assembler = new FragmentAssembler();
  stats = { lines: 0, invalid: 0, decoded: 0, ignored: 0 };

  constructor(private readonly ctx: SourceContext) {}

  push(line: string, now = Date.now()): AisEvent | null {
    this.stats.lines++;
    const s = parseSentence(line);
    if (!s) {
      if (line.trim()) this.stats.invalid++;
      return null;
    }
    const full = this.assembler.push(s, now);
    if (!full) return null;
    const msg = decodePayload(full.payload, full.fillBits);
    if (!msg) {
      this.stats.ignored++;
      return null;
    }
    this.stats.decoded++;
    return toEvent(msg, now, this.ctx);
  }
}

/**
 * Drops duplicates of the same report heard by overlapping receivers.
 * Key = mmsi + rounded position + course; TTL-bounded.
 */
export class Deduper {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs = 5_000) {}

  isDuplicate(e: AisEvent, now = Date.now()): boolean {
    if (e.kind !== "position") return false;
    const d = e.data;
    const key = `${d.mmsi}|${d.lat.toFixed(5)}|${d.lon.toFixed(5)}|${d.cog ?? ""}`;
    const prev = this.seen.get(key);
    this.seen.set(key, now);
    if (this.seen.size > 50_000) {
      for (const [k, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(k);
    }
    return prev !== undefined && now - prev < this.ttlMs;
  }
}
