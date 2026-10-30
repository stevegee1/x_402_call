import { PAID_ENDPOINTS, type EndpointId } from "@mx/shared";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

export function createResourceServer(facilitator: FacilitatorClient, network: `${string}:${string}`) {
  return new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
}

/**
 * Payment requirements per endpoint are static (fixed price, payTo, network), so they are built
 * once and reused: the 402 challenge path never touches the network.
 */
export class RequirementsCache {
  private cache = new Map<EndpointId, PaymentRequirements[]>();

  constructor(
    private readonly server: x402ResourceServer,
    private readonly o: { payTo: string; network: `${string}:${string}`; maxTimeoutSeconds: number },
  ) {}

  async get(id: EndpointId): Promise<PaymentRequirements[]> {
    let reqs = this.cache.get(id);
    if (!reqs) {
      reqs = await this.server.buildPaymentRequirements({
        scheme: "exact",
        payTo: this.o.payTo,
        price: `$${PAID_ENDPOINTS[id].priceUsd}`,
        network: this.o.network,
        maxTimeoutSeconds: this.o.maxTimeoutSeconds,
      });
      this.cache.set(id, reqs);
    }
    return reqs;
  }

  async warm() {
    for (const id of Object.keys(PAID_ENDPOINTS) as EndpointId[]) await this.get(id);
  }
}
