import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface SpendRecord {
  ts: number;
  agentId: string;
  costCentre?: string;
  rail: "x402" | "credits";
  url: string;
  origin: string;
  /** x402: USD (USDC). credits: GBP. */
  amount: number;
  currency: "USD" | "GBP";
  network?: string;
  payTo?: string;
  status: number;
  paymentId?: string;
  transaction?: string;
}

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Append-only spend log. In-memory, optionally mirrored to a JSONL file so budgets survive restarts. */
export class SpendLog {
  private records: SpendRecord[] = [];

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim()) this.records.push(JSON.parse(line) as SpendRecord);
      }
    }
  }

  add(r: SpendRecord) {
    this.records.push(r);
    if (this.path) appendFileSync(this.path, JSON.stringify(r) + "\n");
  }

  spentToday(currency: "USD" | "GBP", now = Date.now()): number {
    const day = utcDay(now);
    return this.records.filter((r) => r.currency === currency && utcDay(r.ts) === day).reduce((s, r) => s + r.amount, 0);
  }

  all(): readonly SpendRecord[] {
    return this.records;
  }

  onDay(day: string): SpendRecord[] {
    return this.records.filter((r) => utcDay(r.ts) === day);
  }
}
