import { inBbox, type BBox, type LonLat } from "./geo";

export type RegionId = "dover" | "rotterdam" | "panama";

export interface Anchorage {
  id: string;
  name: string;
  polygon: LonLat[];
}

export interface Region {
  id: RegionId;
  name: string;
  bbox: BBox;
  anchorages: Anchorage[];
  /** No message from the region for this long => snapshot is stale and we stop charging. */
  staleAfterMs: number;
  status: "live" | "beta";
}

const rect = (minLon: number, minLat: number, maxLon: number, maxLat: number): LonLat[] => [
  [minLon, minLat],
  [maxLon, minLat],
  [maxLon, maxLat],
  [minLon, maxLat],
];

// Polygons are deliberately coarse rectangles for the MVP.
// TODO(M2): replace with charted anchorage boundaries (UKHO / Port of Rotterdam / ACP).
export const REGIONS: Record<RegionId, Region> = {
  dover: {
    id: "dover",
    name: "Dover Strait",
    bbox: [0.95, 50.7, 2.1, 51.35],
    anchorages: [{ id: "downs", name: "The Downs (off Deal)", polygon: rect(1.42, 51.18, 1.52, 51.28) }],
    staleAfterMs: 120_000,
    status: "live",
  },
  rotterdam: {
    id: "rotterdam",
    name: "Port of Rotterdam approaches",
    bbox: [3.3, 51.85, 4.6, 52.15],
    anchorages: [{ id: "maas-offshore", name: "Maas offshore anchorages", polygon: rect(3.45, 51.95, 3.9, 52.1) }],
    staleAfterMs: 120_000,
    status: "beta",
  },
  panama: {
    id: "panama",
    name: "Panama Canal approaches",
    bbox: [-80.1, 8.7, -79.4, 9.5],
    anchorages: [
      { id: "atlantic", name: "Atlantic (Limon Bay / Cristobal)", polygon: rect(-79.98, 9.33, -79.85, 9.45) },
      { id: "pacific", name: "Pacific (Balboa / Flamenco)", polygon: rect(-79.6, 8.78, -79.45, 8.92) },
    ],
    staleAfterMs: 300_000,
    status: "beta",
  },
};

export const REGION_IDS = Object.keys(REGIONS) as RegionId[];

export function isRegionId(v: string): v is RegionId {
  return Object.hasOwn(REGIONS, v);
}

export function regionForPoint(lon: number, lat: number): RegionId | undefined {
  return REGION_IDS.find((id) => inBbox(lon, lat, REGIONS[id].bbox));
}
