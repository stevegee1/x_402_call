import type { KeeperLog, TickResult } from "./keeper";

/**
 * Ticks the keeper every `intervalMs` (from the end of the previous tick, so ticks never overlap)
 * until stopped. stop() lets a tick in flight finish the transaction it is waiting on (it starts no
 * new one) and waits up to maxWaitMs for it. A step that outlasts that is cut off; the next process
 * waits for its transaction to mine (pending nonce) before planning, so nothing is done twice.
 */
export function startLoop(
  keeper: { tick(): Promise<TickResult | null>; idle(): Promise<void>; requestStop(): void },
  o: { intervalMs: number; startDelayMs: number },
  log: KeeperLog,
) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      const r = await keeper.tick();
      if (r) log.info({ ...r }, "tick");
    } catch (e) {
      log.error({ err: e }, "tick crashed");
    }
    if (!stopped) timer = setTimeout(loop, o.intervalMs);
  };
  // The first tick waits out the previous deployment's shutdown, so two keepers never act at once.
  timer = setTimeout(loop, o.startDelayMs);
  return {
    async stop(maxWaitMs: number) {
      stopped = true;
      clearTimeout(timer);
      keeper.requestStop();
      await Promise.race([keeper.idle(), new Promise<void>((r) => setTimeout(r, maxWaitMs).unref())]);
    },
  };
}
