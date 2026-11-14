-- Paid means delivered (I14). A sync payment is settled before its data is served, so between the
-- settle and the response going out, the buyer's money has moved but nothing has been delivered.
-- (The handler runs before the settle, so a handler failure is cancelled, never charged.) If the
-- settle outcome is unknown on the request path (timeout), the client disconnects or the replica
-- dies in that window, the buyer has paid for nothing, and the EIP-3009 nonce is spent so the same
-- signature can't simply be paid again.
--
-- A sync payment is therefore owed from the moment it is admitted until a response with the data
-- has been produced. Resending the identical PAYMENT-SIGNATURE for the same path serves an owed,
-- settled payment, exactly once, with no second charge (apps/gateway/src/payments/billing.ts).
--
-- owed_since:         set at admission for sync payments; cleared once the data is delivered.
-- redeem_token:       the redemption in flight. Only its holder can finish or release it.
-- redeem_lease_until: when that redemption is presumed dead (database clock), so a replica that
--                     dies mid-request can't strand the debt.
--
-- Adding nullable columns without defaults is a catalog-only change: no table rewrite. The lock
-- timeout keeps a long-running transaction from queueing every payment behind this migration.
set local lock_timeout = '5s';

alter table x402_payments
  add column owed_since timestamptz,
  add column redeem_token uuid,
  add column redeem_lease_until timestamptz,
  -- When the request path handed the payment to the facilitator. A sync payment is admitted unarmed;
  -- the settlement worker never submits one that was never armed (it can only confirm it on chain or,
  -- once expired, fail it), whatever its clock says. Async payments are armed at admission.
  add column armed_at timestamptz;

-- Payments recorded before this migration were all submittable by the worker: keep it that way.
update x402_payments set armed_at = created_at where status = 'verified';
