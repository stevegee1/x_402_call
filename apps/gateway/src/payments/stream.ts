import { usdToUsdcAtomic } from "@mx/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps, AppEnv } from "../context";
import type { StreamRoute } from "../platform/catalog";
import { resolveForSale } from "./billing";

/** Keeps idle connections open through proxies; never charged. */
const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events paid per event from an x402 session (architecture.md §6.4). The first event
 * is charged before any byte is sent, so every refusal is still a normal HTTP error (402, 401, 503)
 * that a client can act on. After that, each event is charged as it is sent. When the balance runs
 * out or the session expires, the stream sends a final `session_ended` event and closes.
 */
export function sessionStream(route: StreamRoute, d: AppDeps) {
  return async (c: Context<AppEnv>) => {
    const resolved = resolveForSale(route.product, c, d);
    if (resolved instanceof Response) return resolved;
    if (!d.sessions) return c.json({ error: "sessions_disabled" }, 401);
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Session ")) {
      return c.json({ error: "session_required", detail: "streams are paid from an x402 session", sessions: { sizes: `${d.cfg.PUBLIC_BASE_URL}/v1/sessions/sizes`, usage: "Authorization: Session <token>" } }, 402);
    }
    const token = auth.slice(8).trim();
    const sessions = d.sessions;
    const price = usdToUsdcAtomic(route.resource.pricing.priceUsd);
    const resource = route.resource.id;

    // The first event's charge doubles as authorisation: refuse here, before the stream starts.
    const first = await sessions.charge(token, resource, price);
    if (!first.ok) {
      d.metrics.inc("session_refused_total", { reason: first.reason });
      if (first.reason === "exhausted") return c.json({ error: "session_exhausted" }, 402);
      if (first.reason === "unavailable") return c.json({ error: "sessions_unavailable" }, 503);
      if (first.reason === "expired" || first.reason === "closed") return c.json({ error: "session_expired" }, 401);
      return c.json({ error: "invalid_session" }, 401);
    }

    d.metrics.inc("streams_opened_total", { resource });
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ended = false;
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      let prepaid: typeof first | undefined = first;
      let unsubscribe: (() => void) | undefined;
      // Events go out one at a time, in order, each charged before it is written.
      let queue = Promise.resolve();

      const end = async (reason: string) => {
        if (ended) return;
        ended = true;
        if (prepaid?.ok) sessions.refund(prepaid.ticket);
        prepaid = undefined;
        if (!stream.aborted) await stream.writeSSE({ event: "session_ended", data: JSON.stringify({ reason }) }).catch(() => {});
        unsubscribe?.();
        d.metrics.inc("streams_closed_total", { resource, reason });
        done();
      };

      const emit = (event: string, data: unknown): Promise<boolean> => {
        const sent = queue.then(async () => {
          if (ended) return false;
          const charge = prepaid ?? (await sessions.charge(token, resource, price));
          prepaid = undefined;
          if (!charge.ok) {
            await end(charge.reason === "exhausted" ? "balance_spent" : charge.reason === "unavailable" ? "unavailable" : "session_expired");
            return false;
          }
          try {
            await stream.writeSSE({ event, data: JSON.stringify(data) });
            d.metrics.inc("stream_events_total", { resource });
            return true;
          } catch {
            sessions.refund(charge.ticket); // never delivered
            await end("client_gone");
            return false;
          }
        });
        queue = sent.then(() => undefined);
        return sent;
      };

      stream.onAbort(() => void end("client_gone"));
      const heartbeat = setInterval(() => {
        if (!ended) void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => void end("client_gone"));
      }, HEARTBEAT_MS);
      try {
        unsubscribe = route.open(c, resolved.state, emit);
        if (ended) unsubscribe();
        await finished;
      } finally {
        clearInterval(heartbeat);
      }
    });
  };
}
