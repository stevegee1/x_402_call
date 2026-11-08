/**
 * Browser code for /wallet, written against the standard wallet interfaces (EIP-1193 requests,
 * EIP-6963 discovery) with no third-party library, so the page keeps a hash-only CSP and every line
 * that touches a signature is here to review.
 *
 * Split in two: CORE has no DOM access (tested in Node against the real gateway with a wallet
 * stub), UI wires it to the page. All page text is set with textContent: nothing from the network
 * or the wallet is ever parsed as HTML.
 *
 * The x402 payload mirrors @x402/evm's exact-scheme client (EIP-3009 TransferWithAuthorization):
 * validAfter 0, validBefore now + maxTimeoutSeconds, a random 32-byte nonce, EIP-712 domain from the
 * requirements' extra.name/version, chain id from the CAIP-2 network and the asset as verifying
 * contract; then { x402Version, payload, resource, accepted } base64-encoded in PAYMENT-SIGNATURE.
 */
export const WALLET_CORE_JS = `
var core = (function () {
  "use strict";
  var TYPES = {
    EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }
    ],
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
    ]
  };

  function hex(bytes) { var s = "0x"; for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0"); return s; }
  function randomNonce() { var b = new Uint8Array(32); crypto.getRandomValues(b); return hex(b); }
  function chainIdOf(network) { var m = /^eip155:(\\d+)$/.exec(network || ""); if (!m) throw new Error("unsupported network " + network); return Number(m[1]); }
  function b64(text) { var bytes = new TextEncoder().encode(text); var bin = ""; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin); }
  function utf8Hex(text) { return hex(new TextEncoder().encode(text)); }

  function walletError(e) {
    var code = e && (e.code || (e.data && e.data.code));
    if (code === 4001 || code === "ACTION_REJECTED") return "You declined the request in your wallet. Nothing was charged.";
    if (code === 4100) return "Your wallet is locked or hasn't given this site access. Unlock it, then try again.";
    if (e && e.message === "account_changed") return "Your wallet switched to a different account. Reloading…";
    return (e && e.message) || String(e);
  }

  /**
   * Makes sure the wallet still gives this site the address the page shows, before asking for a
   * signature. Wallets lock themselves after idling (MetaMask) or the site's access can be removed;
   * the page doesn't hear about either, and signing then fails with 4100 "not authorized". If
   * access is missing, ask for it (the wallet shows its unlock/connect prompt). If the wallet hands
   * back a different account, stop: never sign as an account the page isn't showing.
   */
  async function access(provider, address, force) {
    var want = String(address).toLowerCase();
    var has = function (list) { return (list || []).some(function (a) { return String(a).toLowerCase() === want; }); };
    if (!force) {
      var current = [];
      try { current = await provider.request({ method: "eth_accounts" }); } catch (e) {}
      if (has(current)) return;
    }
    var granted = await provider.request({ method: "eth_requestAccounts" });
    if (has(granted)) return;
    var err = new Error("account_changed"); err.account = granted && granted[0]; throw err;
  }

  /** A signing request, with access checked first and one retry after re-asking on 4100. */
  async function signAs(provider, address, method, params) {
    await access(provider, address, false);
    try {
      return await provider.request({ method: method, params: params });
    } catch (e) {
      if (!e || e.code !== 4100) throw e;
      await access(provider, address, true);
      return await provider.request({ method: method, params: params });
    }
  }

  /** The exact-scheme offer for our network from a 402 body. */
  function pickOffer(body, network) {
    var accepts = (body && body.accepts) || [];
    for (var i = 0; i < accepts.length; i++) if (accepts[i].scheme === "exact" && accepts[i].network === network) return accepts[i];
    return null;
  }

  function typedData(req, from, nowSec, nonce) {
    if (!req.extra || !req.extra.name || !req.extra.version) throw new Error("the price offer has no token domain (extra.name/version)");
    var authorization = { from: from, to: req.payTo, value: String(req.amount), validAfter: "0", validBefore: String(nowSec + Number(req.maxTimeoutSeconds)), nonce: nonce };
    return {
      authorization: authorization,
      json: JSON.stringify({
        types: TYPES,
        domain: { name: req.extra.name, version: req.extra.version, chainId: chainIdOf(req.network), verifyingContract: req.asset },
        primaryType: "TransferWithAuthorization",
        message: authorization
      })
    };
  }

  function paymentHeader(paymentRequired, req, authorization, signature) {
    var payload = { x402Version: paymentRequired.x402Version, payload: { authorization: authorization, signature: signature }, resource: paymentRequired.resource, accepted: req };
    if (paymentRequired.extensions) payload.extensions = paymentRequired.extensions;
    return b64(JSON.stringify(payload));
  }

  async function ensureChain(provider, chainId) {
    var want = "0x" + chainId.toString(16);
    var have = await provider.request({ method: "eth_chainId" });
    if (String(have).toLowerCase() === want) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      if (e && e.code === 4902 && chainId === 84532) {
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
      } else if (e && e.code === 4902 && chainId === 8453) {
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }] });
      } else throw e;
    }
  }

  async function usdcBalance(provider, asset, address) {
    var data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    var out = await provider.request({ method: "eth_call", params: [{ to: asset, data: data }, "latest"] });
    return BigInt(out && out !== "0x" ? out : "0x0");
  }

  /**
   * Buys a session: ask for the price (402), sign the exact USDC authorization in the wallet (no
   * gas, no transaction from the wallet), and present it. Returns the gateway's session JSON.
   */
  async function buySession(provider, fetchFn, opts) {
    var url = opts.base + "/v1/sessions/" + opts.size;
    var first = await fetchFn(url, { headers: { accept: "application/json" } });
    if (first.status !== 402) throw new Error("expected a price offer, got HTTP " + first.status);
    var pr = await first.json();
    var req = pickOffer(pr, opts.network);
    if (!req) throw new Error("this server doesn't offer " + opts.network + " payments");
    await ensureChain(provider, chainIdOf(req.network));
    if (opts.checkBalance !== false) {
      var bal = await usdcBalance(provider, req.asset, opts.from);
      if (bal < BigInt(req.amount)) {
        var err = new Error("insufficient_usdc"); err.need = String(req.amount); err.have = String(bal); throw err;
      }
    }
    var td = typedData(req, opts.from, Math.floor((opts.now ? opts.now() : Date.now()) / 1000), opts.nonce || randomNonce());
    var signature = await signAs(provider, opts.from, "eth_signTypedData_v4", [opts.from, td.json]);
    var res = await fetchFn(url, { headers: { accept: "application/json", "payment-signature": paymentHeader(pr, req, td.authorization, signature) } });
    var body = await res.json().catch(function () { return {}; });
    if (res.status !== 201 && res.status !== 200) {
      var e2 = new Error((body && body.error) || ("HTTP " + res.status)); e2.status = res.status; e2.body = body; throw e2;
    }
    return body;
  }

  /** Proves control of the address (sign-in message, no funds) and fetches its activity. */
  async function activity(provider, fetchFn, opts) {
    // Check access before fetching a challenge, so an unlock prompt doesn't eat into its 5 minutes.
    await access(provider, opts.from, false);
    var ch = await fetchFn(opts.base + "/v1/wallet/challenge", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ address: opts.from }) });
    if (!ch.ok) throw new Error("sign-in unavailable (HTTP " + ch.status + ")");
    var c = await ch.json();
    var signature = await signAs(provider, opts.from, "personal_sign", [utf8Hex(c.message), opts.from]);
    var res = await fetchFn(opts.base + "/v1/wallet/activity", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ message: c.message, mac: c.mac, signature: signature }) });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  return { buySession: buySession, activity: activity, usdcBalance: usdcBalance, ensureChain: ensureChain, chainIdOf: chainIdOf, walletError: walletError, typedData: typedData, paymentHeader: paymentHeader };
})();
`;

export const WALLET_UI_JS = `
(function () {
  "use strict";
  var root = document.getElementById("wallet");
  if (!root) return;
  var cfg = { base: location.origin, network: root.dataset.network, asset: root.dataset.asset, faucet: root.dataset.faucet, explorer: root.dataset.explorer };
  var chainId = core.chainIdOf(cfg.network);
  var state = { provider: null, address: null, providers: [] };
  var $ = function (id) { return document.getElementById(id); };
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function status(id, kind, text) { var el = $(id); if (!el) return; el.className = "alert " + kind; el.textContent = text; el.hidden = !text; }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function usd(atomic) { return "$" + (Number(atomic) / 1e6).toFixed(Number(atomic) % 10000 ? 3 : 2); }

  // EIP-6963: every installed wallet announces itself; window.ethereum is the fallback.
  window.addEventListener("eip6963:announceProvider", function (ev) {
    var d = ev.detail; if (!d || !d.provider || !d.info) return;
    if (state.providers.some(function (p) { return p.info.uuid === d.info.uuid; })) return;
    state.providers.push(d); renderChoices();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(function () {
    if (!state.providers.length && window.ethereum) { state.providers.push({ info: { uuid: "injected", name: "Browser wallet" }, provider: window.ethereum }); renderChoices(); }
    if (!state.providers.length) { show("no-wallet", true); return; }
    reconnect();
  }, 400);

  // Which wallet this visitor last connected (a per-browser convenience; storage may be blocked).
  var KEY = "wb_wallet";
  function idOf(p) { return p.info.rdns || p.info.uuid; }
  function remembered() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function remember(p) { try { if (p) localStorage.setItem(KEY, idOf(p)); else localStorage.removeItem(KEY); } catch (e) {} }

  /**
   * Back on the page with a wallet that already approved this site: reconnect without a prompt
   * (eth_accounts never prompts). Never pop a wallet window on page load: on the wrong network, or
   * if anything fails, leave the Connect button.
   */
  async function reconnect() {
    var id = remembered(); if (!id) return;
    var p = state.providers.filter(function (x) { return idOf(x) === id; })[0]; if (!p) return;
    try {
      var accounts = await p.provider.request({ method: "eth_accounts" });
      if (!accounts || !accounts.length) return;
      var have = await p.provider.request({ method: "eth_chainId" });
      if (String(have).toLowerCase() !== "0x" + chainId.toString(16)) return;
      await connect(p, accounts);
    } catch (e) {}
  }

  function renderChoices() {
    var box = $("choices"); box.textContent = ""; show("no-wallet", false);
    state.providers.forEach(function (p) {
      var b = document.createElement("button"); b.type = "button"; b.className = "btn filled"; b.textContent = "Connect " + p.info.name;
      b.addEventListener("click", function () { connect(p); });
      box.appendChild(b);
    });
  }

  $("disconnect").addEventListener("click", async function () {
    remember(null);
    // Also drop the site's permission where the wallet supports it (MetaMask does); harmless otherwise.
    try { await state.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch (e) {}
    location.reload();
  });

  async function connect(p, known) {
    var provider = p.provider;
    if (!known) status("connect-msg", "info", "Check your wallet to connect…");
    try {
      var accounts = known || await provider.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) throw new Error("no account selected");
      if (!known) await core.ensureChain(provider, chainId);
      state.provider = provider; state.address = accounts[0];
      remember(p);
      provider.on && provider.on("accountsChanged", function () { location.reload(); });
      provider.on && provider.on("chainChanged", function () { location.reload(); });
      status("connect-msg", "", "");
      setText("addr", state.address); setText("addr-short", short(state.address));
      show("connect", false); show("connected", true); show("connect-first", false);
      Array.prototype.forEach.call(document.querySelectorAll("[data-size], #load-activity"), function (b) { b.disabled = false; });
      await refreshBalance();
    } catch (e) { status("connect-msg", "error", core.walletError(e)); }
  }

  async function refreshBalance() {
    try { setText("bal", usd(await core.usdcBalance(state.provider, cfg.asset, state.address)) + " USDC"); }
    catch (e) { setText("bal", "unavailable"); }
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-size]"), function (b) {
    b.addEventListener("click", function () { buy(b.getAttribute("data-size"), b); });
  });

  async function buy(size, button) {
    if (!state.address) return;
    status("buy-msg", "info", "Check your wallet: you're signing a USDC payment. It doesn't cost gas.");
    button.disabled = true;
    try {
      var s = await core.buySession(state.provider, fetch.bind(window), { base: cfg.base, network: cfg.network, size: size, from: state.address });
      status("buy-msg", "ok", "Session bought. Copy the token now: it isn't shown again.");
      setText("token", s.session_token); setText("tok-amount", "$" + s.amount_usdc);
      setText("tok-expires", new Date(s.expires_at).toLocaleString());
      setText("tok-curl", 'curl -H "Authorization: Session ' + s.session_token + '" ' + cfg.base + "/v1/grid/england/intensity");
      show("token-box", true);
      await refreshBalance();
    } catch (e) {
      if (e && e.message === "insufficient_usdc") status("buy-msg", "error", "Not enough USDC: this needs " + usd(e.need) + ", the wallet has " + usd(e.have) + "." + (cfg.faucet ? " Get test USDC from " + cfg.faucet : ""));
      else if (e && e.status === 402) status("buy-msg", "error", "Payment not accepted: " + ((e.body && e.body.error) || "unknown reason") + ". You weren't charged.");
      else { status("buy-msg", "error", core.walletError(e)); if (e && e.message === "account_changed") setTimeout(function () { location.reload(); }, 1200); }
    } finally { button.disabled = false; }
  }

  $("copy").addEventListener("click", function () {
    navigator.clipboard.writeText($("token").textContent).then(function () { setText("copy", "Copied"); setTimeout(function () { setText("copy", "Copy token"); }, 1500); });
  });

  $("load-activity").addEventListener("click", async function () {
    status("act-msg", "info", "Check your wallet: sign the message to prove it's yours. It moves no funds.");
    try {
      var a = await core.activity(state.provider, fetch.bind(window), { base: cfg.base, from: state.address });
      status("act-msg", "", "");
      renderSessions(a.sessions || []); renderPayments(a.payments || []);
      show("activity", true);
    } catch (e) { status("act-msg", "error", core.walletError(e)); if (e && e.message === "account_changed") setTimeout(function () { location.reload(); }, 1200); }
  });

  function cell(tr, text, cls, label) { var td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; if (label) td.setAttribute("data-label", label); tr.appendChild(td); return td; }
  function renderSessions(rows) {
    var tb = $("sessions-body"); tb.textContent = "";
    show("sessions-empty", !rows.length);
    rows.forEach(function (s) {
      var tr = document.createElement("tr");
      cell(tr, s.session_id.slice(0, 8));
      cell(tr, usd(s.amount_atomic), "num", "Bought");
      cell(tr, usd(s.remaining_atomic), "num", "Left");
      cell(tr, s.state === "active" ? "Active until " + new Date(s.expires_at).toLocaleTimeString() : "Ended");
      tb.appendChild(tr);
    });
  }
  function renderPayments(rows) {
    var tb = $("payments-body"); tb.textContent = "";
    show("payments-empty", !rows.length);
    rows.forEach(function (p) {
      var tr = document.createElement("tr");
      cell(tr, new Date(p.created_at).toLocaleString());
      cell(tr, p.endpoint);
      cell(tr, usd(p.amount_atomic), "num", "Amount");
      cell(tr, p.status);
      var td = cell(tr, "");
      if (p.tx_hash && cfg.explorer) { var a = document.createElement("a"); a.href = cfg.explorer + p.tx_hash; a.rel = "noopener"; a.target = "_blank"; a.textContent = "View"; td.appendChild(a); }
      tb.appendChild(tr);
    });
  }
})();
`;
