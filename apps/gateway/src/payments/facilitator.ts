import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { CircuitBreaker, type BreakerOptions, type BreakerState } from "./breaker";

export class FacilitatorUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`no facilitator available: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FacilitatorUnavailableError";
  }
}

export const FACILITATOR_BREAKER: BreakerOptions = { windowMs: 30_000, minCalls: 10, failureRate: 0.2, slowCallMs: 1_500, openMs: 30_000 };

/**
 * Primary facilitator (Coinbase CDP) behind a circuit breaker, with an optional self-hosted
 * fallback. Transport errors fail over; "invalid payment" results are normal responses and do not.
 *
 * Settling on the fallback after an indeterminate primary timeout is safe: the EIP-3009 nonce is
 * single-use on-chain, so at most one settlement can succeed.
 */
export class FailoverFacilitator implements FacilitatorClient {
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly primary: FacilitatorClient,
    private readonly fallback?: FacilitatorClient,
    onBreakerChange?: (name: string, s: BreakerState) => void,
    opts: BreakerOptions = FACILITATOR_BREAKER,
  ) {
    this.breaker = new CircuitBreaker("facilitator_primary", opts, onBreakerChange);
  }

  private async call<T>(fn: (f: FacilitatorClient) => Promise<T>): Promise<T> {
    try {
      return await this.breaker.exec(() => fn(this.primary));
    } catch (e) {
      if (!this.fallback) throw new FacilitatorUnavailableError(e);
      try {
        return await fn(this.fallback);
      } catch (e2) {
        throw new FacilitatorUnavailableError(e2);
      }
    }
  }

  verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    return this.call((f) => f.verify(payload, req));
  }

  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    return this.call((f) => f.settle(payload, req));
  }

  getSupported(): Promise<SupportedResponse> {
    return this.call((f) => f.getSupported());
  }
}
