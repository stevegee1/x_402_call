/**
 * Our curated list of UK data-centre sites (decided 2026-11-17: site intelligence is keyed by sites
 * we define, not buyer-submitted coordinates). DRAFT for review: each entry's address comes from a
 * public directory (`source`), and its coordinates from postcodes.io (ONS postcode centroid, Open
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
  /** Cluster several buildings share (weather and grid are the same for all). */
  cluster: "slough" | "docklands" | "hayes";
  gridRegion: "south_england" | "london";
  source: string;
}

export const SITES: readonly Site[] = [
  { id: "equinix_ld4", name: "Equinix LD4", operator: "Equinix", address: "2 Buckingham Avenue, Slough Trading Estate, Slough", postcode: "SL1 4NB", lat: 51.523513, lon: -0.636079, cluster: "slough", gridRegion: "south_england", source: "https://www.peeringdb.com/fac/399" },
  { id: "equinix_ld5", name: "Equinix LD5", operator: "Equinix", address: "8 Buckingham Avenue, Slough Trading Estate, Slough", postcode: "SL1 4AX", lat: 51.522155, lon: -0.629143, cluster: "slough", gridRegion: "south_england", source: "https://datacentermap.com/united-kingdom/slough/equinix-ld5-slough" },
  { id: "equinix_ld6", name: "Equinix LD6", operator: "Equinix", address: "352 Buckingham Avenue, Slough", postcode: "SL1 4PF", lat: 51.521689, lon: -0.623103, cluster: "slough", gridRegion: "south_england", source: "https://www.colo-x.com/data-centre/equinix-ld6-slough/" },
  { id: "equinix_ld7", name: "Equinix LD7", operator: "Equinix", address: "1 Banbury Avenue, Slough", postcode: "SL1 4LH", lat: 51.525471, lon: -0.633555, cluster: "slough", gridRegion: "south_england", source: "https://www.datacentermap.com/united-kingdom/london/equinix-slough-campus/" },
  { id: "telehouse_north", name: "Telehouse London Docklands (North)", operator: "Telehouse", address: "14 Coriander Avenue, London", postcode: "E14 2AA", lat: 51.51207, lon: -0.002022, cluster: "docklands", gridRegion: "london", source: "https://www.peeringdb.com/fac/34" },
  { id: "equinix_ld8", name: "Equinix LD8 (Harbour Exchange)", operator: "Equinix", address: "6-9 Harbour Exchange Square, London", postcode: "E14 9GE", lat: 51.498934, lon: -0.015953, cluster: "docklands", gridRegion: "london", source: "https://www.peeringdb.com/fac/45" },
  { id: "colt_hayes", name: "Colt London Hayes Campus", operator: "Colt DCS", address: "Beaconsfield Road / Uxbridge Road, Hayes", postcode: "UB4 0JZ", lat: 51.510417, lon: -0.393692, cluster: "hayes", gridRegion: "london", source: "https://www.datacentermap.com/united-kingdom/london/colt-london-hayes-campus/" },
];
