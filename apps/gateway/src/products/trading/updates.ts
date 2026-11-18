/**
 * Tells trading stream subscribers that a dataset has a new version in memory. The composition
 * root publishes after the dataset's cache has taken the version in, so a subscriber reading the
 * cache sees it.
 */
export class TradingUpdates {
  private readonly subscribers = new Map<string, Set<() => void>>();

  subscribe(dataset: string, fn: () => void): () => void {
    let set = this.subscribers.get(dataset);
    if (!set) {
      set = new Set();
      this.subscribers.set(dataset, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  publish(dataset: string): void {
    for (const fn of [...(this.subscribers.get(dataset) ?? [])]) {
      try {
        fn();
      } catch {
        // one subscriber's failure never stops the others
      }
    }
  }

  subscriberCount(dataset: string): number {
    return this.subscribers.get(dataset)?.size ?? 0;
  }
}
