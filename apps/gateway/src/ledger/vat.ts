/**
 * VAT rules for the MVP. NOT tax advice: the treatment below must be signed off by the
 * company's accountant before mainnet (implementation.md §8.3, decision D9).
 *
 *  - x402 (anonymous): no evidence of customer location/status, so treated as a UK supply.
 *    Prices are VAT-INCLUSIVE; VAT is extracted from the gross.
 *  - Fiat credits (identified B2B accounts):
 *      UK customer            -> standard rate 20%, charged on top-up (single-purpose voucher)
 *      non-UK + VAT/tax id    -> reverse charge, 0% charged, invoice carries reverse-charge wording
 *      non-UK without tax id  -> refused at account creation (we do not make B2C supplies abroad)
 */
export const UK_VAT_RATE = 0.2;

export type VatTreatment = "uk_standard" | "reverse_charge" | "uk_standard_inclusive";

export function splitInclusive(grossMicros: number, rate = UK_VAT_RATE): { netMicros: number; vatMicros: number } {
  const vatMicros = Math.round((grossMicros * rate) / (1 + rate));
  return { netMicros: grossMicros - vatMicros, vatMicros };
}

export function creditsVat(country: string, netMicros: number): { treatment: VatTreatment; vatMicros: number; grossMicros: number } {
  if (country.toUpperCase() === "GB") {
    const vatMicros = Math.round(netMicros * UK_VAT_RATE);
    return { treatment: "uk_standard", vatMicros, grossMicros: netMicros + vatMicros };
  }
  return { treatment: "reverse_charge", vatMicros: 0, grossMicros: netMicros };
}

/** Format check only. TODO(M3): verify UK numbers via HMRC "Check a UK VAT number" API, EU via VIES. */
export function validateTaxId(country: string, taxId: string | undefined): string | null {
  const c = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "country must be an ISO 3166-1 alpha-2 code";
  if (c === "GB") {
    if (taxId && !/^GB(\d{9}|\d{12})$/.test(taxId.replace(/\s/g, ""))) return "UK VAT number must look like GB123456789";
    return null;
  }
  if (!taxId) return "non-UK accounts must provide a VAT/tax id (business customers only)";
  if (!/^[A-Z0-9]{4,20}$/.test(taxId.replace(/[\s-]/g, "").toUpperCase())) return "tax id format not recognised";
  return null;
}
