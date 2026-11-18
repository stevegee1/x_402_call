/**
 * Agent demo for screen recordings. Paste into the DevTools console on the gateway's /wallet page
 * (it allows same-origin fetch; other sites can't call the API from a browser).
 *
 * It behaves like a small agent: reads the catalog, picks endpoints, pays per call with credits,
 * and reasons over the answers. About £0.10 per run.
 */
(async () => {
  const KEY = window.WB_KEY || prompt("API key (mk_…)"); // set window.WB_KEY off-camera to keep it out of the video
  if (!KEY) return;
  const base = location.origin;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (who, text, color) => console.log(`%c${who}%c ${text}`, `background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-weight:600`, "color:inherit;font-size:13px");
  const agent = (t) => say("🤖 agent", t, "#5b4bdb");
  const tool = (t) => say("⚙ call", t, "#0b7a75");
  const money = (t) => say("£ paid", t, "#b26a00");
  let spent = 0, balance = null;

  async function call(path) {
    tool(`GET ${path}`);
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const charged = Number(r.headers.get("x-credits-charged-gbp-micros") ?? 0) / 1e6;
    balance = Number(r.headers.get("x-credits-balance-gbp-micros") ?? 0) / 1e6;
    spent += charged;
    money(`£${charged.toFixed(3)} · balance £${balance.toFixed(3)}`);
    await sleep(700);
    return r.json();
  }

  console.clear();
  agent("Task: plan a heavy compute job in the UK for the cleanest power, and check shipping delays into Rotterdam.");
  await sleep(1200);

  agent("Discovering what data is available…");
  const cat = await (await fetch(`${base}/v1/products?format=json`)).json();
  console.table(cat.data.filter((p) => p.kind === "data").flatMap((p) => p.endpoints.filter((e) => e.kind === "paid").map((e) => ({ endpoint: e.id, price: e.pay.credits ? `£${e.pay.credits.price_gbp}` : "—", what: e.summary }))));
  await sleep(1500);

  const t = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", weekday: "short" });

  agent("Checking grid carbon intensity right now in England, Scotland and Wales…");
  const now = {};
  for (const n of ["england", "scotland", "wales"]) now[n] = await call(`/v1/grid/${n}/intensity`);
  console.table(Object.fromEntries(Object.entries(now).map(([n, r]) => [n, { "gCO2/kWh now": r.intensity, "next 24h min": r.min_next_24h, "next 24h max": r.max_next_24h }])));
  const nation = Object.keys(now).sort((a, b) => now[a].intensity - now[b].intensity)[0];
  agent(`${nation[0].toUpperCase() + nation.slice(1)} is cleanest right now (${now[nation].intensity} gCO2/kWh). Can I do better by waiting?`);
  await sleep(1000);

  const w = (await call(`/v1/grid/${nation}/window?duration_h=3`)).window;
  await sleep(600);

  agent("Now the shipping side: anchorage queue at Rotterdam…");
  const q = (await call(`/v1/maritime/rotterdam/queue`)).data;
  const ships = q.anchorages.reduce((n, a) => n + a.waiting, 0);
  const busiest = [...q.anchorages].sort((a, b) => b.waiting - a.waiting)[0];
  await sleep(800);

  const calls = Object.keys(now).length + 2;
  const lines = [
    `⚡ Run the 3-hour job in ${nation[0].toUpperCase() + nation.slice(1)} from ${t(w.from)} to ${t(w.to)} (UK time): ${w.mean_intensity} gCO2/kWh` +
      (w.saving_pct > 0 ? `, ${w.saving_pct}% cleaner than starting now.` : ". Starting now is already the cleanest option."),
    `🚢 Rotterdam: ${ships} ships waiting at anchor` +
      (busiest && busiest.waiting ? `, most at ${busiest.name}` + (busiest.wait_hours.median != null ? ` (median wait ${busiest.wait_hours.median} h).` : ".") : "."),
    `💷 ${calls} paid calls, £${spent.toFixed(3)} total. No contract, no subscription. Balance left £${balance.toFixed(3)}.`,
  ];
  console.log("%cVerdict", "font-size:16px;font-weight:700;margin-top:8px");
  for (const l of lines) console.log(`%c${l}`, "font-size:14px;line-height:1.6");
})().catch((e) => console.error("agent stopped:", e.message));
