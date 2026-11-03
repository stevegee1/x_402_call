import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertBalanced, computeHash, GENESIS_HASH, normalizeJournal, type JournalEntry, type JournalInput } from "../ledger/journal";
import type { CreditAccount, NewAccount, NewPayment, PaymentRow, PaymentStatus, Store } from "./types";

// bigint columns (balances, micros) fit in JS safe integers for our ranges; parse them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

const LEDGER_LOCK = 727274;

type Q = pg.PoolClient | pg.Pool;

function rowToPayment(r: Record<string, any>): PaymentRow {
  return {
    id: r.id,
    network: r.network,
    payer: r.payer,
    nonce: r.nonce,
    amountAtomic: BigInt(r.amount_atomic),
    endpoint: r.endpoint,
    resource: r.resource,
    status: r.status,
    payload: r.payload,
    requirements: r.requirements,
    validBefore: r.valid_before,
    fxRate: Number(r.fx_usdc_gbp),
    fxSource: r.fx_source,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    txHash: r.tx_hash,
    error: r.error,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

function rowToAccount(r: Record<string, any>): CreditAccount {
  return {
    id: r.id,
    company: r.company,
    email: r.email,
    country: r.country,
    taxId: r.tax_id,
    balanceMicros: Number(r.balance_micros),
    status: r.status,
    createdAt: r.created_at,
  };
}

export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });
  }

  async ping() {
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  close() {
    return this.pool.end();
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }

  /** Must run inside a transaction: the advisory lock serialises the hash chain. */
  private async appendJournal(c: pg.PoolClient, input: JournalInput) {
    const j = normalizeJournal(input);
    assertBalanced(j.lines);
    await c.query("select pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
    const prev = (await c.query<{ hash: string }>("select hash from ledger_journal order by seq desc limit 1")).rows[0]?.hash ?? GENESIS_HASH;
    await c.query(
      `insert into ledger_journal (id, kind, ref, occurred_at, lines, memo, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [j.id, j.kind, j.ref, j.occurredAt, JSON.stringify(j.lines), JSON.stringify(j.memo), prev, computeHash(prev, j)],
    );
  }

  async insertPayment(p: NewPayment) {
    const r = await this.pool.query(
      `insert into x402_payments (id, network, payer, nonce, amount_atomic, endpoint, resource, status, payload, requirements, valid_before, fx_usdc_gbp, fx_source, next_attempt_at)
       values ($1, $2, lower($3), $4, $5, $6, $7, 'verified', $8, $9, $10, $11, $12, $13)
       on conflict (network, payer, nonce) do nothing`,
      [p.id, p.network, p.payer, p.nonce, p.amountAtomic.toString(), p.endpoint, p.resource, JSON.stringify(p.payload), JSON.stringify(p.requirements), p.validBefore, p.fxRate, p.fxSource, p.nextAttemptAt],
    );
    return r.rowCount === 1 ? ("inserted" as const) : ("duplicate" as const);
  }

  async getPayment(id: string) {
    const r = await this.pool.query("select * from x402_payments where id = $1", [id]);
    return r.rows[0] ? rowToPayment(r.rows[0]) : null;
  }

  async claimDuePayments(now: Date, limit: number, leaseMs: number) {
    const r = await this.pool.query(
      // UPDATE … RETURNING does not preserve the subquery's ORDER BY, so re-sort the claimed rows:
      // oldest first, because the oldest authorisations are the closest to validBefore.
      `with claimed as (
         update x402_payments set next_attempt_at = $1::timestamptz + make_interval(secs => $3::double precision / 1000)
         where id in (
           select id from x402_payments
           where status = 'verified' and next_attempt_at <= $1
           order by created_at limit $2
           for update skip locked)
         returning *)
       select * from claimed order by created_at, id`,
      [now, limit, leaseMs],
    );
    return r.rows.map(rowToPayment);
  }

  async settlePayment(id: string, txHash: string | null, journal: JournalInput) {
    await this.tx(async (c) => {
      const r = await c.query(
        "update x402_payments set status = 'settled', tx_hash = $2, settled_at = now(), error = null where id = $1 and status = 'verified'",
        [id, txHash],
      );
      if (r.rowCount === 1) await this.appendJournal(c, journal);
    });
  }

  async failPayment(id: string, error: string, final: boolean, nextAttemptAt?: Date) {
    await this.pool.query(
      `update x402_payments set attempts = attempts + 1, error = $2,
         status = case when $3 then 'failed' else status end,
         next_attempt_at = coalesce($4, next_attempt_at)
       where id = $1 and status = 'verified'`,
      [id, error.slice(0, 1_000), final, nextAttemptAt ?? null],
    );
  }

  async cancelPayment(id: string, reason: string) {
    await this.pool.query("update x402_payments set status = 'cancelled', error = $2 where id = $1 and status = 'verified'", [id, reason]);
  }

  async listPayments(opts: { status?: PaymentStatus; limit: number }) {
    const r = opts.status
      ? await this.pool.query("select * from x402_payments where status = $1 order by created_at desc limit $2", [opts.status, opts.limit])
      : await this.pool.query("select * from x402_payments order by created_at desc limit $1", [opts.limit]);
    return r.rows.map(rowToPayment);
  }

  async unsettledByPayer() {
    const r = await this.pool.query<{ payer: string; atomic: string }>(
      "select payer, sum(amount_atomic)::text as atomic from x402_payments where status = 'verified' group by payer",
    );
    return r.rows.map((x) => ({ payer: x.payer, atomic: BigInt(x.atomic) }));
  }

  async createAccount(a: NewAccount, keyHash: string, keyPrefix: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "insert into credit_accounts (id, company, email, country, tax_id) values ($1, $2, $3, $4, $5) returning *",
        [randomUUID(), a.company, a.email, a.country.toUpperCase(), a.taxId],
      );
      const acct = rowToAccount(r.rows[0]);
      await c.query("insert into api_keys (account_id, key_hash, key_prefix) values ($1, $2, $3)", [acct.id, keyHash, keyPrefix]);
      return acct;
    });
  }

  async accountByKeyHash(hash: string) {
    const r = await this.pool.query(
      "select a.* from api_keys k join credit_accounts a on a.id = k.account_id where k.key_hash = $1 and k.revoked_at is null",
      [hash],
    );
    return r.rows[0] ? rowToAccount(r.rows[0]) : null;
  }

  async getAccount(id: string) {
    const r = await this.pool.query("select * from credit_accounts where id = $1", [id]);
    return r.rows[0] ? rowToAccount(r.rows[0]) : null;
  }

  async debit(accountId: string, micros: number, endpoint: string, journal: JournalInput) {
    return this.tx(async (c) => {
      // Conditional update: the balance check and the debit are one atomic statement.
      const r = await c.query<{ balance_micros: number }>(
        "update credit_accounts set balance_micros = balance_micros - $2 where id = $1 and status = 'active' and balance_micros >= $2 returning balance_micros",
        [accountId, micros],
      );
      if (r.rowCount !== 1) {
        const b = await c.query<{ balance_micros: number }>("select balance_micros from credit_accounts where id = $1", [accountId]);
        return { ok: false, balanceMicros: b.rows[0]?.balance_micros ?? 0 };
      }
      await c.query("insert into credit_usage (account_id, endpoint, micros) values ($1, $2, $3)", [accountId, endpoint, micros]);
      await this.appendJournal(c, journal);
      return { ok: true, balanceMicros: r.rows[0]!.balance_micros };
    });
  }

  async refund(accountId: string, micros: number, journal: JournalInput) {
    await this.tx(async (c) => {
      const r = await c.query("update credit_accounts set balance_micros = balance_micros + $2 where id = $1", [accountId, micros]);
      if (r.rowCount !== 1) throw new Error(`unknown account ${accountId}`);
      await c.query("insert into credit_usage (account_id, endpoint, micros) values ($1, 'refund', $2)", [accountId, -micros]);
      await this.appendJournal(c, journal);
    });
  }

  async applyTopUp(t: { ref: string; accountId: string; netMicros: number; vatMicros: number }, journal: JournalInput) {
    return this.tx(async (c) => {
      // Lock the account first: gives a clear error for an unknown account (rather than an FK
      // violation) and serialises top-ups per account.
      const acct = await c.query("select 1 from credit_accounts where id = $1 for update", [t.accountId]);
      if (acct.rowCount !== 1) throw new Error(`unknown account ${t.accountId}`);
      const r = await c.query(
        "insert into credit_topups (ref, account_id, net_micros, vat_micros) values ($1, $2, $3, $4) on conflict (ref) do nothing",
        [t.ref, t.accountId, t.netMicros, t.vatMicros],
      );
      if (r.rowCount !== 1) return "duplicate" as const;
      await c.query("update credit_accounts set balance_micros = balance_micros + $2 where id = $1", [t.accountId, t.netMicros]);
      await this.appendJournal(c, journal);
      return "applied" as const;
    });
  }

  async usage(accountId: string, limit: number) {
    const r = await this.pool.query(
      "select endpoint, micros, created_at from credit_usage where account_id = $1 order by created_at desc limit $2",
      [accountId, limit],
    );
    return r.rows.map((x) => ({ endpoint: x.endpoint, micros: Number(x.micros), at: x.created_at }));
  }

  async journal(range?: { from?: Date; to?: Date }) {
    const r = await this.pool.query(
      `select * from ledger_journal
       where ($1::timestamptz is null or occurred_at >= $1) and ($2::timestamptz is null or occurred_at < $2)
       order by seq`,
      [range?.from ?? null, range?.to ?? null],
    );
    return r.rows.map(
      (x): JournalEntry => ({
        seq: Number(x.seq),
        id: x.id,
        kind: x.kind,
        ref: x.ref,
        occurredAt: (x.occurred_at as Date).toISOString(),
        lines: x.lines,
        memo: x.memo,
        prevHash: x.prev_hash,
        hash: x.hash,
      }),
    );
  }

  async addPolicyEvents(accountId: string, events: unknown[]) {
    if (events.length === 0) return;
    await this.pool.query(
      "insert into policy_events (account_id, event) select $1, e from jsonb_array_elements($2::jsonb) as e",
      [accountId, JSON.stringify(events)],
    );
  }

  async listPolicyEvents(limit: number) {
    const r = await this.pool.query("select account_id, event, received_at from policy_events order by id desc limit $1", [limit]);
    return r.rows.map((x) => ({ accountId: x.account_id, event: x.event, receivedAt: x.received_at }));
  }

  async setCondition(id: string, value: unknown, source: string) {
    await this.pool.query(
      `insert into reference_conditions (id, value, source) values ($1, $2, $3)
       on conflict (id) do update set value = excluded.value, source = excluded.source, updated_at = now()`,
      [id, JSON.stringify(value), source],
    );
  }

  async getCondition(id: string) {
    const r = await this.pool.query("select value, source, updated_at from reference_conditions where id = $1", [id]);
    const x = r.rows[0];
    return x ? { value: x.value, source: x.source, updatedAt: x.updated_at } : null;
  }
}
