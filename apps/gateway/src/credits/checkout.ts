import Stripe from "stripe";

export interface CheckoutRequest {
  accountId: string;
  email: string;
  packId: string;
  label: string;
  netMicros: number;
  vatMicros: number;
  vatTreatment: string;
  successUrl: string;
  cancelUrl: string;
}

export type WebhookResult =
  | { type: "topup_paid"; sessionId: string; accountId: string; packId: string; netMicros: number; vatMicros: number; vatTreatment: string }
  | { type: "ignored"; eventType: string };

/** Payment-provider seam so the credits flow is testable without Stripe. */
export interface CheckoutGateway {
  createCheckout(r: CheckoutRequest): Promise<{ id: string; url: string }>;
  parseWebhook(rawBody: string, signature: string): Promise<WebhookResult>;
}

const toPence = (micros: number) => Math.round(micros / 10_000);

/**
 * Stripe Checkout in GBP. VAT is computed by us (see ledger/vat.ts) and shown as its own line so the
 * Stripe invoice, our ledger and the VAT return agree to the penny.
 * TODO(M3): evaluate Stripe Tax once the accountant has signed off the treatment.
 */
export class StripeCheckout implements CheckoutGateway {
  private stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(r: CheckoutRequest) {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { quantity: 1, price_data: { currency: "gbp", unit_amount: toPence(r.netMicros), product_data: { name: `API credits: ${r.label}` } } }, // credits are spendable on every product
    ];
    if (r.vatMicros > 0) {
      lineItems.push({ quantity: 1, price_data: { currency: "gbp", unit_amount: toPence(r.vatMicros), product_data: { name: "UK VAT @ 20%" } } });
    }
    const metadata = {
      account_id: r.accountId,
      pack: r.packId,
      net_micros: String(r.netMicros),
      vat_micros: String(r.vatMicros),
      vat_treatment: r.vatTreatment,
    };
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: r.email,
      client_reference_id: r.accountId,
      line_items: lineItems,
      metadata,
      payment_intent_data: { metadata },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata,
          footer: r.vatTreatment === "reverse_charge" ? "Reverse charge: customer to account for VAT." : undefined,
        },
      },
      success_url: r.successUrl,
      cancel_url: r.cancelUrl,
    });
    if (!session.url) throw new Error("stripe returned no checkout url");
    return { id: session.id, url: session.url };
  }

  async parseWebhook(rawBody: string, signature: string): Promise<WebhookResult> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
      return { type: "ignored", eventType: event.type };
    }
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status !== "paid") return { type: "ignored", eventType: `${event.type}:${s.payment_status}` };
    const m = s.metadata ?? {};
    return {
      type: "topup_paid",
      sessionId: s.id,
      accountId: m.account_id ?? "",
      packId: m.pack ?? "",
      netMicros: Number(m.net_micros),
      vatMicros: Number(m.vat_micros),
      vatTreatment: m.vat_treatment ?? "",
    };
  }
}
