import { createSocket } from "node:dgram";
import { createConnection, type Socket } from "node:net";
import { NmeaPipeline } from "@mx/ais";
import type { AisEvent } from "@mx/shared";
import type { Source } from "./types";

/**
 * Raw NMEA over UDP: the default output of AIS-catcher / rtl-ais on our own receivers.
 * Receivers reach us over WireGuard; never expose this port publicly.
 * Each datagram may carry several sentences separated by CRLF.
 */
export function udpNmeaSource(opts: { port: number; host: string; receiverId: string }): Source {
  const pipeline = new NmeaPipeline({ source: `udp:${opts.receiverId}`, mode: "live", receiverId: opts.receiverId });
  const sock = createSocket("udp4");
  return {
    name: `udp:${opts.port}`,
    stats: () => pipeline.stats,
    start(emit: (e: AisEvent) => void) {
      sock.on("message", (buf) => {
        const now = Date.now();
        for (const line of buf.toString("ascii").split(/\r?\n/)) {
          const e = pipeline.push(line, now);
          if (e) emit(e);
        }
      });
      sock.bind(opts.port, opts.host);
    },
    stop: async () => void sock.close(),
  };
}

/** Raw NMEA over a TCP client connection (e.g. a receiver's TCP server or a partner feed). Reconnects with backoff. */
export function tcpNmeaSource(opts: { host: string; port: number; receiverId: string; log: (m: string) => void }): Source {
  const pipeline = new NmeaPipeline({ source: `tcp:${opts.receiverId}`, mode: "live", receiverId: opts.receiverId });
  let sock: Socket | undefined;
  let stopped = false;
  let backoff = 1_000;
  return {
    name: `tcp:${opts.host}:${opts.port}`,
    stats: () => pipeline.stats,
    start(emit) {
      const connect = () => {
        let buffer = "";
        sock = createConnection({ host: opts.host, port: opts.port });
        sock.setEncoding("ascii");
        sock.on("connect", () => {
          backoff = 1_000;
          opts.log(`connected to ${opts.host}:${opts.port}`);
        });
        sock.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          if (buffer.length > 10_000) buffer = "";
          const now = Date.now();
          for (const line of lines) {
            const e = pipeline.push(line, now);
            if (e) emit(e);
          }
        });
        sock.on("error", (err) => opts.log(`tcp error: ${err.message}`));
        sock.on("close", () => {
          if (stopped) return;
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        });
      };
      connect();
    },
    stop: async () => {
      stopped = true;
      sock?.destroy();
    },
  };
}
