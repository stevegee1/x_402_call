import { REGIONS, regionForPoint, type AisEvent, type RegionId } from "@mx/shared";
import WebSocket from "ws";
import type { Source } from "./types";

/**
 * aisstream.io websocket (free, community terrestrial coverage).
 * LICENSING: check aisstream.io terms before reselling derived data; treat as a development/beta
 * source until a redistribution-cleared feed or our own receivers cover the region.
 */
const URL = "wss://stream.aisstream.io/v0/stream";

interface Envelope {
  MessageType?: string;
  MetaData?: { MMSI?: number; time_utc?: string };
  Message?: Record<string, Record<string, unknown> | undefined>;
}

function parseTime(s: string | undefined): number {
  // e.g. "2026-10-22 13:45:12.123456789 +0000 UTC"
  const t = s ? Date.parse(`${s.slice(0, 23).replace(" ", "T")}Z`) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function toEvents(msg: Envelope): AisEvent[] {
  const type = msg.MessageType;
  const body = type ? msg.Message?.[type] : undefined;
  const mmsi = num(msg.MetaData?.MMSI) ?? num(body?.UserID);
  if (!type || !body || !mmsi) return [];
  const ts = parseTime(msg.MetaData?.time_utc);

  if (type === "PositionReport" || type === "StandardClassBPositionReport" || type === "ExtendedClassBPositionReport") {
    const lat = num(body.Latitude);
    const lon = num(body.Longitude);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    const region = regionForPoint(lon, lat);
    if (!region) return [];
    const heading = num(body.TrueHeading);
    const cog = num(body.Cog);
    const sog = num(body.Sog);
    return [
      {
        kind: "position",
        region,
        data: {
          mmsi,
          lat,
          lon,
          sog: sog !== undefined && sog < 102.3 ? sog : undefined,
          cog: cog !== undefined && cog < 360 ? cog : undefined,
          heading: heading !== undefined && heading !== 511 ? heading : undefined,
          navStatus: num(body.NavigationalStatus),
          ts,
          source: "aisstream",
          mode: "live",
        },
      },
    ];
  }
  if (type === "ShipStaticData") {
    const dim = (body.Dimension ?? {}) as Record<string, unknown>;
    const length = (num(dim.A) ?? 0) + (num(dim.B) ?? 0);
    const beam = (num(dim.C) ?? 0) + (num(dim.D) ?? 0);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().replace(/@+$/, "").trim() : undefined);
    return [
      {
        kind: "static",
        data: {
          mmsi,
          imo: num(body.ImoNumber) || undefined,
          name: str(body.Name),
          callsign: str(body.CallSign),
          shipType: num(body.Type) || undefined,
          lengthM: length || undefined,
          beamM: beam || undefined,
          draughtM: num(body.MaximumStaticDraught) || undefined,
          destination: str(body.Destination),
          ts,
          source: "aisstream",
        },
      },
    ];
  }
  return [];
}

export function aisstreamSource(opts: { apiKey: string; regions: RegionId[]; log: (m: string) => void }): Source {
  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = 1_000;
  const stats = { messages: 0, events: 0, reconnects: 0 };
  return {
    name: "aisstream",
    stats: () => stats,
    start(emit) {
      const connect = () => {
        ws = new WebSocket(URL);
        ws.on("open", () => {
          backoff = 1_000;
          ws!.send(
            JSON.stringify({
              APIKey: opts.apiKey,
              // aisstream bounding boxes are [[lat, lon], [lat, lon]].
              BoundingBoxes: opts.regions.map((r) => {
                const [minLon, minLat, maxLon, maxLat] = REGIONS[r].bbox;
                return [[minLat, minLon], [maxLat, maxLon]];
              }),
              FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData"],
            }),
          );
          opts.log("aisstream subscribed");
        });
        ws.on("message", (raw) => {
          stats.messages++;
          try {
            for (const e of toEvents(JSON.parse(raw.toString()) as Envelope)) {
              stats.events++;
              emit(e);
            }
          } catch {
            /* malformed frame: ignore */
          }
        });
        ws.on("error", (err) => opts.log(`aisstream error: ${err.message}`));
        ws.on("close", () => {
          if (stopped) return;
          stats.reconnects++;
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60_000);
        });
      };
      connect();
    },
    stop: async () => {
      stopped = true;
      ws?.close();
    },
  };
}
