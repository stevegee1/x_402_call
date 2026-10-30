import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../context";
import { CreditsError } from "../credits/service";
import { verifyChain } from "../ledger/journal";
import type { PaymentStatus } from "../store/types";

const CONSOLE_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../console/index.html"), "utf8");
export const PANAMA_DRAUGHT_CONDITION = "panama.draught_limit";

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
      exposure_usdc: Number(d.exposure.total) / 1e6,
      facilitator_breaker: d.facilitator.breaker.state,
      network: d.cfg.X402_NETWORK,
      settlement_mode: d.cfg.SETTLEMENT_MODE,
    });
  });

  a.get("/payments", async (c) => {
    const status = c.req.query("status") as PaymentStatus | undefined;
    const rows = await d.store.listPayments({ status, limit: Math.min(Number(c.req.query("limit") ?? 50), 500) });
    return c.json({
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        endpoint: p.endpoint,
        payer: p.payer,
        amount_usdc: Number(p.amountAtomic) / 1e6,
        tx: p.txHash,
        attempts: p.attempts,
        error: p.error,
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
        if (l.account === "liability:vat_output") vatDue += l.credit - l.debit;
        if (e.kind === "x402_settlement" && l.account === "revenue:data_api") netSales += l.credit;
        if (e.kind === "credits_topup" && l.account === "liability:customer_credits") netSales += l.credit;
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

  a.put("/conditions/panama-draught", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const value = Number(body.value_m);
    if (!(value > 5 && value < 20)) return c.json({ error: "value_m must be a plausible draught in metres" }, 400);
    const source = String(body.source ?? "").slice(0, 300);
    if (!source) return c.json({ error: "source is required (e.g. ACP advisory number)" }, 400);
    await d.store.setCondition(PANAMA_DRAUGHT_CONDITION, { value_m: value }, source);
    d.engine.draughtLimits.panama = { value_m: value, source, updated_at: new Date().toISOString() };
    return c.json({ ok: true });
  });

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
