-- 009: a wallet's own activity (the /wallet page): its x402 payments and sessions, newest first.
-- Payers are stored lowercase.
create index x402_payments_payer_created on x402_payments (payer, created_at desc);
create index x402_sessions_payer_created on x402_sessions (payer, created_at desc);
