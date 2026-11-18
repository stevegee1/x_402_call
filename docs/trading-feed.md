# Trading feed

Every half-hourly GB power series we record from NESO and Elexon, sold per call on the same rails as every other product (x402, GBP credits, x402 sessions). Every published version is kept, so a buyer can ask what a value was **as known at any past moment**: backtests without look-ahead.

Base path: `/v1/trading`. Switched on by `TRADING_ENABLED=true` (needs `DATABASE_URL`; ingest-env must be running).

## Datasets

`GET /v1/trading/datasets` (free) lists them live, with freshness, where each series' history starts, prices and the source.

| Key | Source | Kind | Unit | Series |
|---|---|---|---|---|
| `carbon_intensity` | NESO | forecast, 48 h | gCO2/kWh | england, scotland, wales |
| `regional_carbon_intensity` | NESO | forecast, 48 h | gCO2/kWh | 14 distribution regions |
| `embedded_wind_solar` | NESO | forecast | MW | wind, wind_capacity, solar, solar_capacity |
| `wind_forecast_14d` | NESO | forecast, 14 days | MW | wind, wind_capacity |
| `demand_forecast_2_14d` | NESO | forecast, 2-14 days | MW | gb |
| `generation_mix` | NESO | outturn, ~12 days late | MW | gas, coal, nuclear, wind, wind_embedded, hydro, imports, biomass, other, solar, storage, generation |
| `system_prices` | Elexon | price | GBP/MWh | ssp, sbp |
| `market_index` | Elexon | price | GBP/MWh | apx |

Environment Agency data (flood, rivers) is not in the trading feed: it is site data, and the EA forbids safety-critical use.

## Endpoints and prices

Grid's price scale (decided 2026-11-18). USDC prices are VAT-inclusive and include the network-fee allowance; credits are GBP net of VAT.

| Endpoint | Returns | USDC | Credits |
|---|---|---|---|
| `GET /:dataset/latest` | Every series: its newest period at or before now, latest version, `known_at` | $0.012 | £0.010 |
| `GET /:dataset/:series/history?from&to&as_of` | Each period in a range (past or ahead, at most 7 days), the version that stood at `as_of` (default now) | $0.052 | £0.042 |
| `GET /:dataset/:series/revisions?period` | Every version of one period, oldest first | $0.022 | £0.017 |
| `GET /:dataset/stream` (SSE) | The live view on connect and on every new version: each series' newest period at or before now and every period ahead | $0.012 / event | session only |

Times are ISO 8601 with an explicit zone. `period` must sit on a 30-minute boundary.

## What a version means

- `from`: the period start (UTC).
- `value`, `quality`: `ok`, `missing` (the source published nothing) or `rejected` (failed our range checks; never invented or filled).
- `known_at`: when **we** first held this version. This is the `as_of` key: `as_of=T` returns, per period, the newest version with `known_at <= T`.
- `published_at`: the source's own publish time, when it gives one.

## Never charged

- Unknown dataset or series: 404.
- Bad parameters: 400, checked before any charge.
- Stale dataset (ingest has not fetched it for 20 minutes, or the gateway can't reach the store): 503. Each dataset is judged on its own; one source being down never stops the others.
- A history or revisions read that finds nothing: 404 `no_history`, with `history_from`.
- Store unavailable for an old-history read: 503 `history_unavailable`.

## Where reads come from

The gateway follows every dataset in memory (one Postgres LISTEN connection for all of them). Recent periods (2 days; 21 days for generation mix, so `latest` is always a memory read) are answered from memory; older history goes to Postgres with a 1.2 s budget. Both paths return the same answer for the same question.

## Licence lines

Every response carries `source` with the licence and attribution. Pages carry both lines in the footer:

- NESO: "Supported by National Energy SO Open Data". Not provided or endorsed by NESO.
- Elexon: "Contains BMRS data © Elexon Limited copyright and database right <year>". Wording to confirm with Elexon.

## History depth

History starts when ingest started recording each dataset: NESO from 2026-11-07, Elexon from 2026-11-17. `GET /v1/trading/datasets` gives the exact start per series.
