import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PricedResource } from "../platform/product";

export function createResourceServer(facilitator: FacilitatorClient, network: `${string}:${string}`) {
  return new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
}

/**
 * Payment requirements per resource are static (fixed price, payTo, network), so they are built
 * once and reused: the 402 challenge path never touches the network. Keyed by resource id, which
 * the catalog guarantees is unique.
 */
export class RequirementsCache {
  private cache = new Map<string, PaymentRequirements[]>();

  constructor(
    private readonly server: x402ResourceServer,
    private readonly o: { payTo: string; network: `${string}:${string}`; maxTimeoutSeconds: number },
  ) {}

  async get(resource: PricedResource): Promise<PaymentRequirements[]> {
    let reqs = this.cache.get(resource.id);
    if (!reqs) {
      reqs = await this.server.buildPaymentRequirements({
        scheme: "exact",
        payTo: this.o.payTo,
        price: `$${resource.pricing.priceUsd}`,
        network: this.o.network,
        maxTimeoutSeconds: this.o.maxTimeoutSeconds,
      });
      this.cache.set(resource.id, reqs);
    }
    return reqs;
  }

  async warm(resources: readonly PricedResource[]) {
    for (const r of resources) await this.get(r);
  }
}
