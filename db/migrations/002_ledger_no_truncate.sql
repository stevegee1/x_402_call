-- 002: close the TRUNCATE gap in the append-only ledger.
-- 001's row-level trigger blocks UPDATE and DELETE, but TRUNCATE fires only statement-level
-- triggers, so `truncate ledger_journal` would silently erase the books. Block it too.
-- (Production also runs the gateway as a non-owner role without TRUNCATE privilege; this is the
-- second line of defence and covers the owner/migration role.)

create trigger ledger_journal_no_truncate before truncate on ledger_journal
  for each statement execute function ledger_journal_immutable();
