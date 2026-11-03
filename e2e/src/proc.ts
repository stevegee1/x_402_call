import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Each service's stdout/stderr goes here, so a failing run can be diagnosed afterwards. */
export const LOG_DIR = join(ROOT, "e2e/.logs");

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface Service {
  name: string;
  proc: ChildProcess;
  logFile: string;
  stop(): Promise<void>;
}

/** Spawns a long-running service with its output captured to e2e/.logs/<name>.log. */
export function startService(name: string, cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Service {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `${name}.log`);
  const log = createWriteStream(logFile, { flags: "w" });
  const proc = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    // A clean environment: nothing from the developer's shell (.env, DATABASE_URL, keys) leaks in.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.pipe(log, { end: false });
  proc.stderr?.pipe(log, { end: false });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
    log.end();
  });

  return {
    name,
    proc,
    logFile,
    async stop() {
      if (exited || proc.exitCode !== null) return;
      const done = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await done;
      clearTimeout(t);
    },
  };
}

/** Polls `probe` until it returns true; fails fast if the service process dies first. */
export async function waitFor(what: string, probe: () => Promise<boolean>, opts: { timeoutMs?: number; service?: Service } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    if (opts.service && opts.service.proc.exitCode !== null) {
      throw new Error(`${opts.service.name} exited with code ${opts.service.proc.exitCode} while waiting for ${what}; see ${opts.service.logFile}`);
    }
    try {
      if (await probe()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}${opts.service ? `; see ${opts.service.logFile}` : ""}`);
}

export const httpOk = (url: string) => async () => (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
