-- 006: x402 sessions (architecture.md §6.4). One settled x402 payment buys a session: a prepaid
-- USDC balance that reads then spend from memory, so the read path needs no facilitator, no chain
-- and no database.
--
-- The session is derived from its payment (same id), so a buyer who has the token always has the
-- balance, even if the gateway crashed between settling and answering. Replicas lease chunks of the
-- balance (reserved_atomic), spend them in memory, and report usage (spent_atomic) in batches. Each
-- report moves the matching share of the GBP liability booked at purchase into product revenue.
create table x402_sessions (
  payment_id          uuid primary key references x402_payments (id),
  payer               text not null,
  amount_atomic       bigint not null check (amount_atomic > 0),
  reserved_atomic     bigint not null default 0,
  spent_atomic        bigint not null default 0,
  net_gbp_micros      bigint not null check (net_gbp_micros >= 0),
  released_gbp_micros bigint not null default 0,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  closed_at           timestamptz,
  check (0 <= spent_atomic and spent_atomic <= reserved_atomic and reserved_atomic <= amount_atomic),
  check (0 <= released_gbp_micros and released_gbp_micros <= net_gbp_micros)
);
-- The sweeper closes expired sessions and books what was never used.
create index x402_sessions_open_expiry on x402_sessions (expires_at) where closed_at is null;
