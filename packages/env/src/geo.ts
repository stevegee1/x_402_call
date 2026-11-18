/**
 * Small, exact geometry for site data: which polygon holds a site, and how far apart two points
 * are. Deterministic and dependency-free; a full GIS library would be thousands of lines for two
 * functions.
 */

type Ring = ReadonlyArray<readonly [number, number] | readonly number[]>;

/** Even-odd ray cast: true when (x, y) is strictly inside the ring. Points on an edge may go either way. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/**
 * True when the point lies inside a GeoJSON Polygon or MultiPolygon (outer ring minus holes).
 * Coordinates in the geometry's own order: GeoJSON is [lon, lat], so pass (lon, lat).
 * Any other geometry type, or malformed coordinates, is false.
 */
export function pointInGeometry(x: number, y: number, g: GeoJsonGeometry | null | undefined): boolean {
  if (!g || !Array.isArray(g.coordinates)) return false;
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polygons) {
    if (!Array.isArray(poly) || poly.length === 0 || !poly.every(isRing)) continue;
    const [outer, ...holes] = poly as Ring[];
    if (inRing(x, y, outer!) && !holes.some((h) => inRing(x, y, h))) return true;
  }
  return false;
}

const isRing = (r: unknown): r is Ring =>
  Array.isArray(r) && r.length >= 4 && r.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

/** Straight-line distance in metres between two British National Grid points (a plane: exact for this use). */
export const bngDistanceM = (e1: number, n1: number, e2: number, n2: number) => Math.hypot(e1 - e2, n1 - n2);

/** Great-circle distance in metres (haversine, mean Earth radius), for checks across coordinate systems. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}
