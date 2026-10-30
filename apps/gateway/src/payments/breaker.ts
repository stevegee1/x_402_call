export class BreakerOpenError extends Error {
  constructor(readonly breaker: string) {
    super(`circuit breaker '${breaker}' is open`);
    this.name = "BreakerOpenError";
  }
}

export interface BreakerOptions {
  windowMs: number;
  minCalls: number;
  /** 0..1: failure share in the window that trips the breaker. */
  failureRate: number;
  /** Calls slower than this count as failures. */
  slowCallMs: number;
  openMs: number;
}

export type BreakerState = "closed" | "open" | "half_open";

/**
 * Rolling-window circuit breaker. Opens on error rate or slow calls; after openMs lets a
 * single probe through (half-open) and closes on success.
 */
export class CircuitBreaker {
  private calls: { at: number; ok: boolean }[] = [];
  private openedAt = 0;
  private probing = false;
  state: BreakerState = "closed";

  constructor(
    readonly name: string,
    private readonly o: BreakerOptions,
    private readonly onChange?: (name: string, state: BreakerState) => void,
  ) {}

  async exec<T>(fn: () => Promise<T>, now = () => Date.now()): Promise<T> {
    if (this.state === "open") {
      if (now() - this.openedAt < this.o.openMs || this.probing) throw new BreakerOpenError(this.name);
      this.transition("half_open");
    }
    if (this.state === "half_open") {
      if (this.probing) throw new BreakerOpenError(this.name);
      this.probing = true;
    }
    const start = now();
    try {
      const out = await fn();
      this.record(now() - start <= this.o.slowCallMs, now());
      return out;
    } catch (e) {
      this.record(false, now());
      throw e;
    } finally {
      this.probing = false;
    }
  }

  forceOpen(now = Date.now()) {
    this.openedAt = now;
    this.transition("open");
  }

  reset() {
    this.calls = [];
    this.transition("closed");
  }

  private record(ok: boolean, at: number) {
    if (this.state === "half_open") {
      if (ok) this.reset();
      else this.forceOpen(at);
      return;
    }
    this.calls.push({ at, ok });
    while (this.calls.length && at - this.calls[0]!.at > this.o.windowMs) this.calls.shift();
    if (this.calls.length < this.o.minCalls) return;
    const failures = this.calls.filter((c) => !c.ok).length;
    if (failures / this.calls.length >= this.o.failureRate) this.forceOpen(at);
  }

  private transition(s: BreakerState) {
    if (s !== this.state) {
      this.state = s;
      this.onChange?.(this.name, s);
    }
  }
}
