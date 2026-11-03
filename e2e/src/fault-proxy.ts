import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { freePort } from "./proc";

/**
 * A TCP proxy in front of a service, with an HTTP control port, so a test can make a dependency
 * fail mid-run. While "down", every connection (new or open) is reset: to the client it looks
 * exactly like the dependency crashing.
 *   POST <control>/down   POST <control>/up   GET <control>/   -> { up }
 */
export async function startFaultProxy(target: { host: string; port: number }) {
  let up = true;
  const open = new Set<Socket>();

  const proxy = createServer((client) => {
    if (!up) return void client.resetAndDestroy();
    const upstream = connect(target.port, target.host);
    open.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.pipe(upstream).pipe(client);
  });

  const control = createHttpServer((req, res) => {
    if (req.method === "POST" && (req.url === "/down" || req.url === "/up")) {
      up = req.url === "/up";
      if (!up) for (const s of open) s.resetAndDestroy();
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ up }));
  });

  const port = await freePort();
  const controlPort = await freePort();
  await new Promise<void>((r) => proxy.listen(port, "127.0.0.1", r));
  await new Promise<void>((r) => control.listen(controlPort, "127.0.0.1", r));

  return {
    url: `http://127.0.0.1:${port}`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    async stop() {
      for (const s of open) s.destroy();
      await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => control.close(r))]);
    },
  };
}
