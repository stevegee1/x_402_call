import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { SupportedNetwork } from "./config";

/**
 * The x402 "exact" scheme on one EVM network (EIP-3009 transferWithAuthorization; Permit2 too, as
 * the library routes on payload type). Smart-wallet deployment via ERC-6492 factories stays off.
 * simulateInSettle re-simulates right before broadcast so we don't spend gas on a doomed transfer.
 */
export function createFacilitator(signer: FacilitatorEvmSigner, network: SupportedNetwork) {
  const f = new x402Facilitator();
  registerExactEvmScheme(f, { signer, networks: network, simulateInSettle: true });
  return f;
}
