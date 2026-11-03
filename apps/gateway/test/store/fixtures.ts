import { randomBytes, randomUUID } from "node:crypto";
import { ACCOUNTS, creditsTopUpJournal, creditsUsageJournal, x402SettlementJournal, type JournalInput } from "../../src/ledger/journal";
import type { NewAccount, NewPayment } from "../../src/store/types";

export const NETWORK = "eip155:84532";

export function newPayment(over: Partial<NewPayment> = {}): NewPayment {
  return {
    id: randomUUID(),
    network: NETWORK,
    payer: `0x${randomBytes(20).toString("hex")}`,
    nonce: `0x${randomBytes(32).toString("hex")}`,
    amountAtomic: 33_000n,
    endpoint: "maritime.vessels",
    resource: "http://gw.test/v1/maritime/dover/vessels",
    payload: { x402Version: 2, payload: { signature: "0xabc", authorization: { value: "33000" } } },
    requirements: { scheme: "exact", network: NETWORK, amount: "33000", extra: { name: "USDC", version: "2" } },
    validBefore: new Date(Date.now() + 600_000),
    fxRate: 0.79,
    fxSource: "fixed:test",
    nextAttemptAt: new Date(Date.now() - 1_000),
    ...over,
  };
}

export function newAccount(over: Partial<NewAccount> = {}): NewAccount {
  return { company: "Acme Shipping Ltd", email: "ops@acme.test", country: "gb", taxId: "GB123456789", ...over };
}

export const keyHash = () => randomBytes(32).toString("hex");

export const settlementJournal = (paymentId: string, amountAtomic = 33_000n): JournalInput =>
  x402SettlementJournal({
    paymentId,
    amountAtomic,
    fxRate: 0.79,
    fxSource: "fixed:test",
    transaction: `0x${randomBytes(32).toString("hex")}`,
    payer: "0xpayer",
    network: NETWORK,
    endpoint: "maritime.vessels",
    occurredAt: new Date().toISOString(),
  });

export const usageJournal = (accountId: string, micros: number, refund = false): JournalInput =>
  creditsUsageJournal({ accountId, micros, endpoint: "maritime.vessels", ref: randomUUID(), occurredAt: new Date().toISOString(), refund });

export const topUpJournal = (accountId: string, ref: string, netMicros: number, vatMicros: number): JournalInput =>
  creditsTopUpJournal({ accountId, netMicros, vatMicros, vatTreatment: "uk_standard", method: "stripe", ref, occurredAt: new Date().toISOString() });

export const unbalancedJournal = (): JournalInput => ({
  id: randomUUID(),
  kind: "credits_usage",
  ref: randomUUID(),
  occurredAt: new Date().toISOString(),
  lines: [
    { account: ACCOUNTS.creditsLiability, debit: 100, credit: 0 },
    { account: "revenue:maritime", debit: 0, credit: 99 },
  ],
  memo: {},
});
