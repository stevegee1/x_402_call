import { CREDIT_PACKS } from "@mx/shared";
import { creditsTopUpJournal } from "../ledger/journal";
import { creditsVat, validateTaxId } from "../ledger/vat";
import type { CreditAccount, NewAccount, Store } from "../store/types";
import type { CheckoutGateway } from "./checkout";
import { generateApiKey, hashApiKey } from "./keys";

export class CreditsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

const KEY_CACHE_TTL_MS = 30_000;

/**
 * Fiat-credit rail: identified B2B accounts prepay GBP (Stripe or bank transfer) and spend it per
 * request via an API key. Credits are only redeemable for our own data, so this is ordinary SaaS
 * prepayment, not custody of customer cryptoassets.
 */
export class CreditsService {
  private keyCache = new Map<string, { accountId: string | null; at: number }>();

  constructor(
    private readonly store: Store,
    private readonly checkout: CheckoutGateway | undefined,
    private readonly opts: { publicBaseUrl: string; keyEnv: "live" | "test" },
  ) {}

  async createAccount(input: NewAccount): Promise<{ account: CreditAccount; apiKey: string }> {
    const company = input.company?.trim();
    const email = input.email?.trim().toLowerCase();
    const country = input.country?.trim().toUpperCase();
    const taxId = input.taxId?.replace(/\s/g, "").toUpperCase() || null;
    if (!company || company.length > 200) throw new CreditsError("invalid_company", "company is required");
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CreditsError("invalid_email", "a valid email is required");
    const taxErr = validateTaxId(country ?? "", taxId ?? undefined);
    if (taxErr) throw new CreditsError("invalid_tax_details", taxErr);

    const { key, hash, prefix } = generateApiKey(this.opts.keyEnv);
    const account = await this.store.createAccount({ company, email, country: country!, taxId }, hash, prefix);
    return { account, apiKey: key };
  }

  /** Resolves an API key to an account. Caches the key->id mapping only, never the balance. */
  async resolveKey(apiKey: string): Promise<CreditAccount | null> {
    const hash = hashApiKey(apiKey);
    const hit = this.keyCache.get(hash);
    if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) {
      return hit.accountId ? this.store.getAccount(hit.accountId) : null;
    }
    const acct = await this.store.accountByKeyHash(hash);
    this.keyCache.set(hash, { accountId: acct?.id ?? null, at: Date.now() });
    if (this.keyCache.size > 10_000) this.keyCache.clear();
    return acct;
  }

  async startCheckout(account: CreditAccount, packId: string) {
    if (!this.checkout) throw new CreditsError("card_payments_unavailable", "card top-ups are not configured; contact sales for invoiced top-up", 503);
    const pack = CREDIT_PACKS[packId];
    if (!pack) throw new CreditsError("unknown_pack", `pack must be one of: ${Object.keys(CREDIT_PACKS).join(", ")}`);
    const vat = creditsVat(account.country, pack.netGbpMicros);
    return this.checkout.createCheckout({
      accountId: account.id,
      email: account.email,
      packId: pack.id,
      label: pack.label,
      netMicros: pack.netGbpMicros,
      vatMicros: vat.vatMicros,
      vatTreatment: vat.treatment,
      successUrl: `${this.opts.publicBaseUrl}/v1/credits/checkout/success`,
      cancelUrl: `${this.opts.publicBaseUrl}/v1/credits/checkout/cancelled`,
    });
  }

  async handleWebhook(rawBody: string, signature: string) {
    if (!this.checkout) throw new CreditsError("card_payments_unavailable", "stripe not configured", 503);
    const r = await this.checkout.parseWebhook(rawBody, signature);
    if (r.type === "ignored") return { applied: false, reason: r.eventType };
    if (!r.accountId || !(r.netMicros > 0) || !(r.vatMicros >= 0)) throw new CreditsError("invalid_webhook_metadata", "checkout session metadata incomplete");
    const result = await this.applyTopUp(r.accountId, r.netMicros, r.vatMicros, r.vatTreatment, "stripe", r.sessionId);
    return { applied: result === "applied", reason: result };
  }

  /** Bank-transfer / invoiced top-ups entered by ops (enterprise customers who will not use cards). */
  async manualTopUp(accountId: string, netMicros: number, reference: string) {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new CreditsError("unknown_account", "account not found", 404);
    if (!Number.isSafeInteger(netMicros) || netMicros <= 0) throw new CreditsError("invalid_amount", "net amount must be positive");
    if (!reference) throw new CreditsError("invalid_reference", "a bank/invoice reference is required (idempotency key)");
    const vat = creditsVat(account.country, netMicros);
    return this.applyTopUp(accountId, netMicros, vat.vatMicros, vat.treatment, "bank_transfer", `bank:${reference}`);
  }

  private applyTopUp(accountId: string, netMicros: number, vatMicros: number, vatTreatment: string, method: "stripe" | "bank_transfer", ref: string) {
    const journal = creditsTopUpJournal({ accountId, netMicros, vatMicros, vatTreatment, method, ref, occurredAt: new Date().toISOString() });
    return this.store.applyTopUp({ ref, accountId, netMicros, vatMicros }, journal);
  }
}
