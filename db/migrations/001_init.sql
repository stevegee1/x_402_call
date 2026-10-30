-- 001: core schema for the MVP gateway.
-- Money: GBP micros (bigint) in the ledger and credits; USDC atomic units (numeric) for x402.

create table x402_payments (
  id              uuid primary key,
  network         text not null,
  payer           text not null,
  nonce           text not null,
  amount_atomic   numeric(78, 0) not null check (amount_atomic > 0),
  endpoint        text not null,
  resource        text not null,
  status          text not null check (status in ('verified', 'settled', 'failed', 'cancelled')),
  payload         jsonb not null,
  requirements    jsonb not null,
  valid_before    timestamptz not null,
  fx_usdc_gbp     numeric(18, 8) not null,
  fx_source       text not null,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  tx_hash         text,
  error           text,
  created_at      timestamptz not null default now(),
  settled_at      timestamptz,
  -- Replay protection: an EIP-3009 authorization nonce is single-use per payer.
  unique (network, payer, nonce)
);
create index x402_payments_due on x402_payments (next_attempt_at) where status = 'verified';
create index x402_payments_created on x402_payments (created_at desc);

create table credit_accounts (
  id             uuid primary key,
  company        text not null,
  email          text not null,
  country        char(2) not null,
  tax_id         text,
  balance_micros bigint not null default 0 check (balance_micros >= 0),
  status         text not null default 'active' check (status in ('active', 'suspended')),
  created_at     timestamptz not null default now()
);

create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references credit_accounts (id),
  key_hash    text not null unique,
  key_prefix  text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table credit_topups (
  ref          text primary key, -- Stripe checkout session id or bank reference (idempotency key)
  account_id   uuid not null references credit_accounts (id),
  net_micros   bigint not null check (net_micros > 0),
  vat_micros   bigint not null check (vat_micros >= 0),
  created_at   timestamptz not null default now()
);

create table credit_usage (
  id          bigserial primary key,
  account_id  uuid not null references credit_accounts (id),
  endpoint    text not null,
  micros      bigint not null,
  created_at  timestamptz not null default now()
);
create index credit_usage_account on credit_usage (account_id, created_at desc);

-- Append-only, hash-chained journal. Lines are part of the hashed content.
create table ledger_journal (
  seq          bigserial primary key,
  id           uuid not null unique,
  kind         text not null,
  ref          text not null,
  occurred_at  timestamptz not null,
  lines        jsonb not null,
  memo         jsonb not null,
  prev_hash    char(64) not null,
  hash         char(64) not null unique
);
create index ledger_journal_occurred on ledger_journal (occurred_at);

create function ledger_journal_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_journal is append-only';
end $$;
create trigger ledger_journal_no_update before update or delete on ledger_journal
  for each row execute function ledger_journal_immutable();

-- Flattened lines for reporting (VAT return boxes, trial balance).
create view ledger_lines as
  select j.seq, j.kind, j.ref, j.occurred_at, l.account, l.debit, l.credit
  from ledger_journal j, jsonb_to_recordset(j.lines) as l(account text, debit bigint, credit bigint);

create table policy_events (
  id           bigserial primary key,
  account_id   uuid not null references credit_accounts (id),
  event        jsonb not null,
  received_at  timestamptz not null default now()
);
create index policy_events_received on policy_events (received_at desc);

create table reference_conditions (
  id          text primary key,
  value       jsonb not null,
  source      text not null,
  updated_at  timestamptz not null default now()
);

-- History for backtests and the future /history product. Partition by month once volume warrants (TimescaleDB in M2).
create table ais_positions (
  ts          timestamptz not null,
  mmsi        integer not null,
  region      text not null,
  lat         double precision not null,
  lon         double precision not null,
  sog         real,
  cog         real,
  heading     smallint,
  nav_status  smallint,
  source      text not null,
  mode        text not null
);
create index ais_positions_region_ts on ais_positions (region, ts desc);
create index ais_positions_mmsi_ts on ais_positions (mmsi, ts desc);
