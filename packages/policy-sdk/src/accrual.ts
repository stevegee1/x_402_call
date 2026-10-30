import type { SpendRecord } from "./spend-log";

/**
 * Aggregates micro-payments into one accrual line per (supplier, cost centre, currency) per day.
 * ERPs must never receive one document per API call.
 *
 * Column layout follows the SAP S/4HANA journal-entry upload template. Field names to be validated
 * against the design partner's tenant in M5 before posting via the Journal Entry OData/SOAP API.
 */
export interface AccrualLine {
  CompanyCode: string;
  DocumentDate: string;
  PostingDate: string;
  GLAccount: string;
  CostCenter: string;
  Supplier: string;
  AmountInTransactionCurrency: string;
  TransactionCurrency: string;
  DocumentItemText: string;
  Reference: string;
}

export interface AccrualOptions {
  day: string; // YYYY-MM-DD
  companyCode: string;
  glAccount: string;
  defaultCostCentre: string;
  /** Map seller origin or payTo address -> ERP supplier id. */
  supplierMap: Record<string, string>;
  unmappedSupplier?: string;
}

export function toAccrualLines(records: readonly SpendRecord[], o: AccrualOptions): AccrualLine[] {
  const groups = new Map<string, { supplier: string; cc: string; currency: string; total: number; count: number; refs: Set<string> }>();
  for (const r of records) {
    if (new Date(r.ts).toISOString().slice(0, 10) !== o.day) continue;
    const supplier = o.supplierMap[r.origin] ?? (r.payTo ? o.supplierMap[r.payTo.toLowerCase()] : undefined) ?? o.unmappedSupplier ?? "UNMAPPED";
    const cc = r.costCentre ?? o.defaultCostCentre;
    const key = `${supplier}|${cc}|${r.currency}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { supplier, cc, currency: r.currency, total: 0, count: 0, refs: new Set() }));
    g.total += r.amount;
    g.count++;
    g.refs.add(r.rail);
  }
  return [...groups.values()].map((g) => ({
    CompanyCode: o.companyCode,
    DocumentDate: o.day,
    PostingDate: o.day,
    GLAccount: o.glAccount,
    CostCenter: g.cc,
    Supplier: g.supplier,
    AmountInTransactionCurrency: g.total.toFixed(g.currency === "USD" ? 6 : 2),
    TransactionCurrency: g.currency,
    DocumentItemText: `Data API usage: ${g.count} calls (${[...g.refs].join("+")})`,
    Reference: `ACCR-${o.day}`,
  }));
}

export function toCsv(lines: AccrualLine[]): string {
  if (lines.length === 0) return "";
  const cols = Object.keys(lines[0]!) as (keyof AccrualLine)[];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return [cols.join(","), ...lines.map((l) => cols.map((c) => esc(l[c])).join(","))].join("\n") + "\n";
}
