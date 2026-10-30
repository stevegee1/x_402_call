/** [lon, lat] */
export type LonLat = [number, number];
/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

export function inBbox(lon: number, lat: number, b: BBox): boolean {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

/** Ray-casting point-in-polygon. Polygon is an open or closed ring of [lon, lat]. */
export function inPolygon(lon: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const crosses = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Distance in metres from a point to the nearest edge of a bbox (0 if outside). */
export function distanceToBboxEdgeM(lon: number, lat: number, b: BBox): number {
  if (!inBbox(lon, lat, b)) return 0;
  return Math.min(
    haversineM(lat, lon, lat, b[0]),
    haversineM(lat, lon, lat, b[2]),
    haversineM(lat, lon, b[1], lon),
    haversineM(lat, lon, b[3], lon),
  );
}

export const KNOT_MPS = 0.514444;
