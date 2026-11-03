-- Global exposure caps (R4). Exposure is derived, never stored: the sum of verified (unsettled)
-- payments that were served before settlement. It can't drift from the payments it describes, and
-- settling, failing or cancelling a payment releases it by changing its status.
--
-- settle_mode records how a payment was admitted. 'sync' payments are settled before anything is
-- served, so they carry no exposure. Rows that already exist default to 'async': conservative, and
-- they leave the sum as soon as they settle.
alter table x402_payments
  add column settle_mode text not null default 'async' check (settle_mode in ('async', 'sync'));

-- Admission sums this partial index under a short global lock; it holds at most cap / min price rows.
create index x402_payments_exposure on x402_payments (payer) include (amount_atomic)
  where status = 'verified' and settle_mode = 'async';
