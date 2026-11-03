import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mintUsdc } from "./chain";

export interface Buyer {
  account: PrivateKeyAccount;
  address: Address;
  http: x402HTTPClient;
}

/** A fresh wallet with USDC and no ETH: x402 (EIP-3009) payments are gasless for the buyer. */
export async function newBuyer(rpcUrl: string, usdcAtomic: bigint): Promise<Buyer> {
  const account = privateKeyToAccount(generatePrivateKey());
  if (usdcAtomic > 0n) await mintUsdc(rpcUrl, account.address, usdcAtomic);
  const http = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }] }));
  return { account, address: account.address, http };
}

/** Requests a paid URL, signs the 402 challenge, and returns the payment header (not yet sent). */
export async function sign(buyer: Buyer, url: string): Promise<{ header: string; payload: PaymentPayload }> {
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402 from ${url}, got ${first.status}: ${await first.text()}`);
  const pr = buyer.http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
  const payload = await buyer.http.createPaymentPayload(pr);
  const header = Object.values(buyer.http.encodePaymentSignatureHeader(payload))[0]!;
  return { header, payload };
}

/** One full x402 purchase: challenge, sign, pay. */
export async function pay(buyer: Buyer, url: string) {
  const { header, payload } = await sign(buyer, url);
  const res = await fetch(url, { headers: { "PAYMENT-SIGNATURE": header } });
  return { res, header, payload, nonce: (payload.payload as { authorization: { nonce: string } }).authorization.nonce };
}

export const sendSigned = (url: string, header: string) => fetch(url, { headers: { "PAYMENT-SIGNATURE": header } });

/** Re-encodes a payload after tampering with it (the signature is left as signed). */
export function encode(buyer: Buyer, payload: PaymentPayload) {
  return Object.values(buyer.http.encodePaymentSignatureHeader(payload))[0]!;
}
