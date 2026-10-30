import type { RegionId } from "./regions";

/** Where a record came from. Simulated/replayed data is never sold on mainnet. */
export type DataMode = "live" | "simulated" | "replay";

export interface VesselPosition {
  mmsi: number;
  lat: number;
  lon: number;
  /** Speed over ground, knots. */
  sog?: number;
  /** Course over ground, degrees. */
  cog?: number;
  /** True heading, degrees. */
  heading?: number;
  /** ITU-R M.1371 navigational status (0 underway, 1 at anchor, 5 moored, ...). */
  navStatus?: number;
  /** Epoch ms at which the message was transmitted/received at source. */
  ts: number;
  source: string;
  mode: DataMode;
  receiverId?: string;
}

export interface VesselStatic {
  mmsi: number;
  imo?: number;
  name?: string;
  callsign?: string;
  shipType?: number;
  lengthM?: number;
  beamM?: number;
  draughtM?: number;
  destination?: string;
  ts: number;
  source: string;
}

export type AisEvent =
  | { kind: "position"; region: RegionId; data: VesselPosition }
  | { kind: "static"; data: VesselStatic };

/** NATS subjects. Positions are partitioned by region; statics are global. */
export const SUBJECTS = {
  position: (region: RegionId) => `ais.pos.${region}`,
  positionWildcard: "ais.pos.*",
  static: "ais.static",
} as const;

/** Coarse ship category from the AIS ship-type code. */
export function shipCategory(shipType: number | undefined): string {
  if (shipType === undefined) return "unknown";
  if (shipType >= 60 && shipType <= 69) return "passenger";
  if (shipType >= 70 && shipType <= 79) return "cargo";
  if (shipType >= 80 && shipType <= 89) return "tanker";
  if (shipType === 30) return "fishing";
  if (shipType === 31 || shipType === 32 || shipType === 52) return "tug";
  if (shipType >= 40 && shipType <= 49) return "high_speed";
  return "other";
}
