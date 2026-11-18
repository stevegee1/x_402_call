# Site intelligence

One report per UK data-centre site on our list, built from public data we record point-in-time. Sold per call on the same rails as every product (x402, GBP credits, x402 sessions). A site is keyed by **our** id, never buyer coordinates (decision 2026-11-17).

Base path: `/v1/sites`. Switched on by `SITES_ENABLED=true` (needs `DATABASE_URL`; ingest-env must be running).

## Sites

`GET /v1/sites/list` (free). The list lives in `packages/env/src/sites.ts` and is **a draft for review**: 4 Equinix buildings in Slough, Telehouse North and Equinix LD8 in Docklands, Colt Hayes. Locations are postcode centroids (within a few hundred metres).

## Endpoints and prices

Grid's price scale. USDC is VAT-inclusive with the network-fee allowance; credits are GBP net of VAT.

| Endpoint | Returns | USDC | Credits |
|---|---|---|---|
| `GET /:site/report?as_of` | Every section below, as it stood at `as_of` (default now) | $0.052 | £0.042 |
| `GET /:site/flood` | Flood warnings in force and river levels, now | $0.012 | £0.010 |

## Report sections

| Section | Source | What it says |
|---|---|---|
| `carbon` | NESO regional carbon intensity, the site's distribution region | Current half-hour, and min/max/mean and the cleanest half-hour over the next 24 h |
| `prices` | Elexon | Latest system sell and buy (imbalance) price, and the market index price, £/MWh |
| `flood` | EA real-time flood API | Warnings and alerts in force on the site's EA flood areas (all areas within 1 km, chosen 2026-11-18) at the last ingest fetch |
| `rivers` | EA real-time levels | Latest level at each gauge near the site's cluster, and its 24 h change. A gauge compares only with itself (datums differ) |
| `water` | EA Water Resource Availability and Abstraction Reliability, Cycle 2 | Whether new water could be licensed at Q30/Q50/Q70/Q95 flows (available, restricted, not available, heavily modified) and the % of time it is available. `assessed: false` where the EA does not assess the location (the tidal Thames at Docklands) |
| `heat` | DESNZ Heat Networks Planning Database | Heat networks within 2 km by stage (operational, under construction, planned) and metres to the nearest live one |

A section is `null` when nothing was recorded for it at the report time; if every section is null the call is refused (404 `no_history`) and not charged.

## Point in time

Every input is stored as versions with the time we first knew them. `as_of=T` reads only versions known by T. Flood state is the one recorded by the last ingest fetch at or before T. Reports within the memory window (2-3 days) are memory reads; older ones read Postgres within a 1.2 s budget per read, and a slow store refuses (503, not charged).

## Never charged

- Unknown site (404), bad `as_of` (400).
- Stale input (503): a report needs every input fresh; the flood endpoint needs only flood and rivers. Half-hourly and 15-minute inputs must have been fetched within 20 minutes, daily ones (water, heat) within 30 hours. `GET /v1/sites/list` names any stale input.
- Store unavailable (503), nothing recorded (404).

## Licences

Every response carries `sources` with each licence line:

- NESO: "Supported by National Energy SO Open Data".
- Elexon: "Contains BMRS data © Elexon Limited copyright and database right <year>" (wording to confirm with Elexon).
- EA real-time: "this uses Environment Agency flood and river level data from the real-time data API (Beta)". **Not for safety-critical use.**
- EA water: "Contains Environment Agency information © Environment Agency and/or database right" (OGL v3).
- DESNZ: "Contains public sector information licensed under the Open Government Licence v3.0".

**Not included:** the EA's 2021 "water stressed areas" classification. That document is © Environment Agency, all rights reserved, and reuse needs EA permission.

## Not yet

- Cooling-load index from ECMWF weather (next).
- Wider site list (after review).
