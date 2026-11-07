-- 005: a commit-ordered sequence on env_observation, so readers can follow new versions
-- incrementally (architecture.md §6.2).
--
-- Writers take a per-dataset transaction lock before inserting (packages/env PgEnvStore), so
-- within a dataset seq values are assigned in commit order. A reader that has seen everything up
-- to seq N can therefore ask for seq > N and never skip a row. ingested_at can't serve as that
-- cursor: it comes from each writer's clock.
--
-- Adding the column numbers existing rows. It is a rewrite, not an UPDATE, so the append-only
-- triggers don't fire.
alter table env_observation add column seq bigserial;
-- Not unique: on a TimescaleDB hypertable a unique index must include valid_from. The sequence
-- already makes seq unique.
create index env_observation_dataset_seq on env_observation (dataset, seq);
