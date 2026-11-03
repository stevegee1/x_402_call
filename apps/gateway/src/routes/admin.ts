import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../context";
import { CreditsError } from "../credits/service";
import { ACCOUNTS, REVENUE_PREFIX, verifyChain } from "../ledger/journal";
import type { PaymentStatus } from "../store/types";

const CONSOLE_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../console/index.html"), "utf8");

function adminAuth(token: string | undefined): MiddlewareHandler<AppEnv> {
  const expected = token ? Buffer.from(token) : undefined;
  return async (c, next) => {
    const got = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (!expected || got.length !== expected.length || !timingSafeEqual(got, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

const gbp = (micros: number) => (micros / 1e6).toFixed(6);

export function adminRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();
  r.get("/console", (c) => c.html(CONSOLE_HTML));

  const a = new Hono<AppEnv>();
  a.use("*", adminAuth(d.cfg.ADMIN_TOKEN));
  a.onError((err, c) => {
    if (err instanceof CreditsError) return c.json({ error: err.code, detail: err.message }, err.status);
    throw err;
  });

  a.get("/summary", async (c) => {
    const journal = await d.store.journal();
    const totals: Record<string, number> = {};
    for (const e of journal) for (const l of e.lines) totals[l.account] = (totals[l.account] ?? 0) + l.debit - l.credit;
    return c.json({
      ledger_balances_gbp: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(gbp(v))])),
      journal_entries: journal.length,
      exposure_usdc: Number((await d.store.exposure()).totalAtomic) / 1e6,
      facilitator_breaker: d.facilitator.breaker.state,
      network: d.cfg.X402_NETWORK,
      settlement_mode: d.cfg.SETTLEMENT_MODE,
    });
  });

  a.get("/payments", async (c) => {
    const status = c.req.query("status") as PaymentStatus | undefined;
    // Page size: 1-500; missing, 0 or non-numeric means the default (50).
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    // Keyset cursor: the id of the last row of the previous page, returned as next_cursor.
    const before = c.req.query("cursor");
    if (before !== undefined && !/^[0-9a-f-]{36}$/.test(before)) return c.json({ error: "invalid_cursor" }, 400);
    const rows = await d.store.listPayments({ status, limit, before });
    const last = rows.at(-1);
    return c.json({
      next_cursor: rows.length === limit && last ? last.id : null,
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        endpoint: p.endpoint,
        payer: p.payer,
        network: p.network,
        nonce: p.nonce,
        amount_atomic: p.amountAtomic.toString(),
        amount_usdc: Number(p.amountAtomic) / 1e6,
        tx: p.txHash,
        attempts: p.attempts,
        error: p.error,
        settle_mode: p.settleMode,
        created_at: p.createdAt.toISOString(),
        settled_at: p.settledAt?.toISOString() ?? null,
      })),
    });
  });

  a.get("/ledger/verify", async (c) => c.json(verifyChain(await d.store.journal())));

  // HMRC-ready export: one row per journal line, GBP, with VAT treatment and crypto valuation evidence.
  a.get("/ledger.csv", async (c) => {
    const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
    const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;
    const rows = ["seq,occurred_at,kind,ref,account,debit_gbp,credit_gbp,vat_treatment,usdc_amount,fx_usdc_gbp,fx_source,tx_hash,hash"];
    for (const e of await d.store.journal({ from, to })) {
      const m = e.memo as Record<string, unknown>;
      for (const l of e.lines) {
        rows.push(
          [e.seq, e.occurredAt, e.kind, e.ref, l.account, gbp(l.debit), gbp(l.credit), m.vat_treatment ?? "", m.usdc_atomic ? Number(m.usdc_atomic) / 1e6 : "", m.fx_usdc_gbp ?? "", m.fx_source ?? "", m.tx ?? "", e.hash].join(","),
        );
      }
    }
    return c.text(rows.join("\n") + "\n", 200, { "content-type": "text/csv", "content-disposition": "attachment; filename=ledger.csv" });
  });

  // VAT return helper (boxes 1 and 6 of the UK VAT100) for a period.
  a.get("/vat-summary", async (c) => {
    const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
    const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;
    let vatDue = 0;
    let netSales = 0;
    for (const e of await d.store.journal({ from, to })) {
      for (const l of e.lines) {
        if (l.account === ACCOUNTS.vatOutput) vatDue += l.credit - l.debit;
        // x402 revenue (any product) is recognised at settlement; credits at top-up.
        if (e.kind === "x402_settlement" && l.account.startsWith(REVENUE_PREFIX)) netSales += l.credit;
        if (e.kind === "credits_topup" && l.account === ACCOUNTS.creditsLiability) netSales += l.credit;
      }
    }
    return c.json({
      period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      box1_vat_due_on_sales_gbp: Number(gbp(vatDue)),
      box6_total_sales_ex_vat_gbp: Number(gbp(netSales)),
      note: "Draft figures for accountant review. Credits are recognised for VAT at top-up (single-purpose voucher treatment).",
    });
  });

  a.post("/credits/:accountId/topup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const netMicros = Math.round(Number(body.net_gbp) * 1e6);
    const result = await d.credits.manualTopUp(c.req.param("accountId"), netMicros, String(body.reference ?? ""));
    if (result === "applied") d.metrics.inc("credits_topups_total", { method: "bank_transfer" });
    return c.json({ result });
  });

  // Product operator routes (/admin/<productId>/…), behind the same auth.
  for (const route of d.catalog.admin) a.on(route.method, route.path, (c) => route.handler(c));

  a.get("/policy-events", async (c) => {
    const rows = await d.store.listPolicyEvents(Math.min(Number(c.req.query("limit") ?? 100), 1_000));
    return c.json({ data: rows.map((r) => ({ account_id: r.accountId, received_at: r.receivedAt.toISOString(), ...(r.event as object) })) });
  });

  a.post("/breakers/facilitator/reset", (c) => {
    d.facilitator.breaker.reset();
    return c.json({ state: d.facilitator.breaker.state });
  });

  r.route("/admin", a);
  return r;
}
