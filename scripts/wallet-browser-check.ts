/**
 * End-to-end check of the /wallet page in real Chrome, with a wallet that signs with a real key.
 *
 *   GATEWAY_URL=https://mxgateway-staging.up.railway.app \
 *   WALLET_PRIVATE_KEY=0x... pnpm tsx scripts/wallet-browser-check.ts
 *
 * Chrome runs headless with the DevTools protocol. A minimal EIP-1193 provider is injected before
 * the page's own script and bridged back here, where viem signs (MetaMask-style: lowercase address,
 * decimal strings in typed data). Then it clicks through the page as a person would: connect, buy a
 * $1 session, show activity. It spends $1 of the wallet's USDC on the gateway's network.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const RPC = process.env.RPC_URL ?? "https://sepolia.base.org";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);
const PORT = 9300 + Math.floor(Math.random() * 500);

const PROVIDER = `(() => {
  const pending = new Map(); let next = 1;
  window.__walletReply = (id, ok, value) => { const p = pending.get(id); pending.delete(id); ok ? p.resolve(value) : p.reject(Object.assign(new Error(value.message), { code: value.code })); };
  const provider = { request: (args) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); __walletBridge(JSON.stringify({ id, args })); }), on: () => {} };
  window.ethereum = provider;
  window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "test-wallet", name: "Test Wallet", icon: "", rdns: "test.wallet" }, provider }) })));
})();`;

async function walletRequest(method: string, params: unknown[] = []): Promise<unknown> {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address.toLowerCase()];
    case "eth_chainId":
      return "0x14a34";
    case "eth_call": {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return ((await r.json()) as { result: string }).result;
    }
    case "eth_signTypedData_v4": {
      const t = JSON.parse(params[1] as string);
      const { EIP712Domain: _, ...types } = t.types;
      const m = t.message;
      return account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) } });
    }
    case "personal_sign":
      return account.signMessage({ message: { raw: params[0] as `0x${string}` } });
    default:
      throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "wallet-check-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,1600", "about:blank"], { stdio: "ignore" });
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l: { type: string; webSocketDebuggerUrl: string }[]) => l.find((t) => t.type === "page")).catch(() => undefined);
    }
    if (!target) throw new Error("Chrome did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const waiting = new Map<number, (v: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const n = ++id;
        waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const errors: string[] = [];
    ws.onmessage = async (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && waiting.has(m.id)) return waiting.get(m.id)!(m), void waiting.delete(m.id);
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: { value?: string }) => a.value).join(" "));
      if (m.method === "Runtime.bindingCalled" && m.params.name === "__walletBridge") {
        const { id: rid, args } = JSON.parse(m.params.payload);
        let reply: string;
        try {
          reply = `window.__walletReply(${rid}, true, ${JSON.stringify(await walletRequest(args.method, args.params))})`;
        } catch (e) {
          const err = e as { message: string; code?: number };
          reply = `window.__walletReply(${rid}, false, ${JSON.stringify({ message: err.message, code: err.code ?? -32603 })})`;
        }
        await send("Runtime.evaluate", { expression: reply });
      }
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Runtime.addBinding", { name: "__walletBridge" });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PROVIDER });
    await send("Page.navigate", { url: `${GATEWAY}/wallet` });

    const evaluate = async (expression: string) => ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result as { value: unknown }).value;
    const until = async (what: string, expression: string, ms = 60_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate(expression)) return;
        await sleep(250);
      }
      const msgs = await evaluate(`[...document.querySelectorAll(".alert")].filter(e => !e.hidden).map(e => e.textContent).join(" | ")`);
      throw new Error(`timed out waiting for ${what}; page says: ${msgs}; errors: ${errors.join("; ")}`);
    };
    const step = (s: string) => console.log(`✔ ${s}`);

    await until("the wallet button", `!!document.querySelector("#choices button")`);
    if (await evaluate(`!!document.querySelector("[data-size]").disabled`)) step("buy buttons disabled before connecting");
    await evaluate(`document.querySelector("#choices button").click()`);
    await until("connected", `!document.getElementById("connected").hidden`);
    await until("balance", `/USDC/.test(document.getElementById("bal").textContent)`, 15_000);
    step(`connected ${await evaluate(`document.getElementById("addr").textContent`)} · ${await evaluate(`document.getElementById("bal").textContent`)}`);

    await evaluate(`document.querySelector('[data-size="usd1"]').click()`);
    await until("session token", `!document.getElementById("token-box").hidden`, 90_000);
    const token = String(await evaluate(`document.getElementById("token").textContent`));
    step(`bought a $1 session: token ${token.slice(0, 12)}… expires ${await evaluate(`document.getElementById("tok-expires").textContent`)}`);
    const read = await fetch(`${GATEWAY}/v1/grid/england/intensity`, { headers: { authorization: `Session ${token}` } });
    if (read.status !== 200) throw new Error(`session read failed: ${read.status}`);
    step(`the token works: read 200, ${read.headers.get("x-session-remaining-usdc-atomic")} atomic left`);

    await evaluate(`document.getElementById("load-activity").click()`);
    await until("activity", `!document.getElementById("activity").hidden`, 30_000);
    const rows = (await evaluate(`[document.querySelectorAll("#sessions-body tr").length, document.querySelectorAll("#payments-body tr").length]`)) as number[];
    step(`activity: ${rows[0]} sessions, ${rows[1]} payments`);

    // Back on the page later: reconnects by itself (no prompt, no click).
    await send("Page.reload");
    await until("silent reconnect", `!document.getElementById("connected").hidden`, 15_000);
    if (await evaluate(`!document.querySelector("[data-size]").disabled`)) step("reload: reconnected without a click, buy buttons enabled");
    // Disconnect: forgotten, and stays disconnected after a reload.
    await evaluate(`document.getElementById("disconnect").click()`);
    await sleep(1500);
    await until("connect button after disconnect", `!!document.querySelector("#choices button")`);
    await sleep(1000);
    if (await evaluate(`document.getElementById("connected").hidden && document.querySelector("[data-size]").disabled`)) step("disconnect: stays disconnected after reload");
    else throw new Error("still connected after disconnect");

    const shot = (await send("Page.captureScreenshot", { format: "png" })).data as string;
    const file = join(profile, "wallet.png");
    writeFileSync(file, Buffer.from(shot, "base64"));
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    console.log(`screenshot: ${file}`);
    ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
});
