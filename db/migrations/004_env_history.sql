-- 004: version history for environmental data (architecture.md §6.3).
--
-- One row for each change to one value. Upstream sources such as NESO overwrite rows in place, so
-- these rows are the only record of what a forecast said at a given moment. A point-in-time read
-- ("as of T") takes, for each period, the newest row with ingested_at <= T.
--
-- Rows are only appended, never changed, so an as-of answer never moves.

create table env_observation (
  dataset      text not null,              -- e.g. 'neso.carbon_intensity'
  region       text not null,              -- e.g. 'england'
  valid_from   timestamptz not null,       -- start of the period the value describes (UTC)
  ingested_at  timestamptz not null,       -- when we first held this version: the as-of key
  published_at timestamptz,                -- when the source says it published (informational)
  value        double precision,
  unit         text not null,
  quality      text not null check (quality in ('ok', 'missing', 'rejected')),
  raw_value    text,                       -- the source's value, kept only when it was rejected
  primary key (dataset, region, valid_from, ingested_at),
  check ((quality = 'ok') = (value is not null)),
  check ((quality = 'rejected') = (raw_value is not null)),
  check (published_at is null or published_at <= ingested_at)
);

create function env_observation_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'env_observation is append-only';
end $$;
create trigger env_observation_no_update before update or delete on env_observation
  for each row execute function env_observation_immutable();
create trigger env_observation_no_truncate before truncate on env_observation
  for each statement execute function env_observation_immutable();

-- Every fetch attempt, failures included. It shows when we were watching, so a point-in-time
-- answer can say how fresh our knowledge was at T, and an outage shows up as a gap here.
create table env_fetch (
  id           bigserial primary key,
  dataset      text not null,
  fetched_at   timestamptz not null,
  published_at timestamptz,
  ok           boolean not null,
  rows_seen    integer not null default 0 check (rows_seen >= 0),
  rows_changed integer not null default 0 check (rows_changed >= 0),
  rows_dropped integer not null default 0 check (rows_dropped >= 0),
  error        text,
  check (ok = (error is null))
);
create index env_fetch_dataset_at on env_fetch (dataset, fetched_at desc);

-- TimescaleDB when the server has it: partition by the period, which every read filters on.
-- Without it (or without the privilege to create it) the table stays plain. The queries are the
-- same either way, and at today's volume (a few thousand changed rows a day) plain Postgres is fine.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'timescaledb') then
    begin
      create extension if not exists timescaledb;
      perform create_hypertable('env_observation', 'valid_from', chunk_time_interval => interval '30 days');
    exception when others then
      raise notice 'TimescaleDB not enabled (%); env_observation stays a plain table', sqlerrm;
    end;
  end if;
end $$;
