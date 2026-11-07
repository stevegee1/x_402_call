-- Served-but-unpaid payments keep counting (architecture.md §5, R4). An async payment is served
-- before it settles. If its settlement then fails for good (the payer moved the funds or cancelled
-- the authorisation first), the data has gone out unpaid. Before this migration that row simply
-- left the exposure sum, so the cap was free again and the same trick could be repeated for ever.
-- Now a failed async payment keeps counting against the caps for a hold window, and its payer is
-- settled synchronously for a longer demotion window. Both windows are measured from created_at
-- (when the payment was made), so no new column is needed; config sets their lengths.
--
-- Numbered 007 so it sorts after the environmental-data migrations (004-006) developed alongside
-- it; it touches only x402_payments and is independent of them.

-- Admission sums recent failures under the global lock: at most (cap / min price) rows per hold window.
create index x402_payments_failed_async_recent on x402_payments (created_at) include (payer, amount_atomic)
  where status = 'failed' and settle_mode = 'async';

-- Demotion is a per-payer existence check, outside the lock.
create index x402_payments_failed_async_payer on x402_payments (payer, created_at)
  where status = 'failed' and settle_mode = 'async';
