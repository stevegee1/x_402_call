/**
 * Tells Grid's stream subscribers that a new version is live. The composition root publishes after
 * the feed has taken the new version in, so a subscriber reading the feed sees it.
 */
export class GridUpdates {
  private subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn();
      } catch {
        // one subscriber's failure never stops the others
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}
