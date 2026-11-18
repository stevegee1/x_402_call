/**
 * Our curated list of UK data-centre sites (decided 2026-11-17: site intelligence is keyed by sites
 * we define, not buyer-submitted coordinates). DRAFT for review: each entry's address comes from a
 * public directory (`source`), and its coordinates (lat/lon and British National Grid) from postcodes.io (ONS postcode centroid, Open
 * Government Licence), resolved 2026-11-17. A postcode centroid is within a few hundred metres of
 * the building: enough for weather, grid region and nearby flood areas, not a survey point.
 *
 * `gridRegion` = the neso.regional_carbon_intensity series for the site's distribution network
 * area. Ids are stored with data: never rename one.
 */
export interface Site {
  id: string;
  name: string;
  operator: string;
  address: string;
  postcode: string;
  lat: number;
  lon: number;
  /** British National Grid (EPSG:27700) metres, from the same postcodes.io lookup: distances to BNG-located data (heat networks). */
  easting: number;
  northing: number;
  /** Cluster several buildings share (weather and grid are the same for all). */
  cluster: "slough" | "docklands" | "hayes";
  gridRegion: "south_england" | "london";
  source: string;
}

export const SITES: readonly Site[] = [
  { id: "equinix_ld4", name: "Equinix LD4", operator: "Equinix", address: "2 Buckingham Avenue, Slough Trading Estate, Slough", postcode: "SL1 4NB", lat: 51.523513, lon: -0.636079, easting: 494721, northing: 181392, cluster: "slough", gridRegion: "south_england", source: "https://www.peeringdb.com/fac/399" },
  { id: "equinix_ld5", name: "Equinix LD5", operator: "Equinix", address: "8 Buckingham Avenue, Slough Trading Estate, Slough", postcode: "SL1 4AX", lat: 51.522155, lon: -0.629143, easting: 495205, northing: 181250, cluster: "slough", gridRegion: "south_england", source: "https://datacentermap.com/united-kingdom/slough/equinix-ld5-slough" },
  { id: "equinix_ld6", name: "Equinix LD6", operator: "Equinix", address: "352 Buckingham Avenue, Slough", postcode: "SL1 4PF", lat: 51.521689, lon: -0.623103, easting: 495625, northing: 181206, cluster: "slough", gridRegion: "south_england", source: "https://www.colo-x.com/data-centre/equinix-ld6-slough/" },
  { id: "equinix_ld7", name: "Equinix LD7", operator: "Equinix", address: "1 Banbury Avenue, Slough", postcode: "SL1 4LH", lat: 51.525471, lon: -0.633555, easting: 494892, northing: 181613, cluster: "slough", gridRegion: "south_england", source: "https://www.datacentermap.com/united-kingdom/london/equinix-slough-campus/" },
  { id: "telehouse_north", name: "Telehouse London Docklands (North)", operator: "Telehouse", address: "14 Coriander Avenue, London", postcode: "E14 2AA", lat: 51.51207, lon: -0.002022, easting: 538741, northing: 181130, cluster: "docklands", gridRegion: "london", source: "https://www.peeringdb.com/fac/34" },
  { id: "equinix_ld8", name: "Equinix LD8 (Harbour Exchange)", operator: "Equinix", address: "6-9 Harbour Exchange Square, London", postcode: "E14 9GE", lat: 51.498934, lon: -0.015953, easting: 537814, northing: 179643, cluster: "docklands", gridRegion: "london", source: "https://www.peeringdb.com/fac/45" },
  { id: "colt_hayes", name: "Colt London Hayes Campus", operator: "Colt DCS", address: "Beaconsfield Road / Uxbridge Road, Hayes", postcode: "UB4 0JZ", lat: 51.510417, lon: -0.393692, easting: 511568, northing: 180277, cluster: "hayes", gridRegion: "london", source: "https://www.datacentermap.com/united-kingdom/london/colt-london-hayes-campus/" },
];

const SLOUGH_FLOOD = ["061FWF23XMhead", "061WAF23Mdnhead", "061FWF23Mdnhead", "061WAF23Slough"] as const;
const DOCKLANDS_FLOOD = [
  "062WAF53LowerLee",
  "063WAT232N",
  "063WAT233N",
  "063WAT232S",
  "063WAT23Central",
  "063FWT23Greenwch",
  "063WAT233S",
  "062FWB53TidalLee",
  "063FWT23RDockA",
  "063FWT23IoDA",
  "063FWT23RDockC",
  "063FWT23BermA",
] as const;
const HAYES_FLOOD = ["062WAF28Pinn", "062FWF36Hilling", "062WAF36FluCrane", "062FWF36Southall"] as const;

/**
 * EA flood areas (warning `FW…` and alert `WA…` areas) within 1 km of each site, from the EA
 * flood-monitoring API (`/id/floodAreas?lat&long&dist=1`), resolved 2026-11-18. Series names in
 * ea.flood_warnings are `fa_` + the id lowercased (floodSeries).
 */
export const SITE_FLOOD_AREAS: Readonly<Record<string, readonly string[]>> = {
  equinix_ld4: SLOUGH_FLOOD,
  equinix_ld5: SLOUGH_FLOOD,
  equinix_ld6: SLOUGH_FLOOD,
  equinix_ld7: SLOUGH_FLOOD,
  telehouse_north: DOCKLANDS_FLOOD,
  equinix_ld8: DOCKLANDS_FLOOD,
  colt_hayes: HAYES_FLOOD,
};

/** The ea.flood_warnings series for a flood area id. */
export const floodSeries = (areaId: string) => `fa_${areaId.toLowerCase()}`;

/** Every flood-warning series any site reads (what a cache of ea.flood_warnings must hold). */
export const SITE_FLOOD_SERIES: readonly string[] = [...new Set(Object.values(SITE_FLOOD_AREAS).flat().map(floodSeries))];
