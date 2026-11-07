/**
 * Animated explainer scenes for the public site: inline SVG, animated with CSS only (no script,
 * no style attributes, so the page keeps a hash-only CSP). Colours come from the M3 tokens, so the
 * scenes follow light and dark mode. Under prefers-reduced-motion every scene is a still diagram
 * that still reads correctly; off screen, the site script pauses them.
 *
 * SVG positions use transform *attributes* on outer groups; CSS animates inner groups only, because
 * a CSS transform replaces an element's transform attribute rather than adding to it.
 */

export const SCENES_CSS = `
.scene{display:block;width:100%;height:auto;overflow:visible}
.scene text{font-family:var(--font);fill:var(--on-surface)}
.scene .t-sm{font-size:11px;fill:var(--on-surface-v)}.scene .t-md{font-size:13px;font-weight:500}.scene .t-lg{font-size:15px;font-weight:500}
.scene .node{fill:var(--surface);stroke:var(--outline-v);stroke-width:1.5}
.scene .node-p{fill:var(--primary-container);stroke:none}
.scene .ink-p{fill:var(--primary)}.scene .ink-t{fill:var(--tertiary)}.scene .ink-w{fill:#e8a200}.scene .ink-v{fill:var(--on-surface-v)}.scene .ink-on-p{fill:var(--on-primary-container)}
.scene .lane{stroke:var(--outline-v);stroke-width:2;stroke-dasharray:4 6;fill:none}
.scene .stroke-p{stroke:var(--primary);fill:none}.scene .stroke-t{stroke:var(--tertiary);fill:none}
.scene.paused *{animation-play-state:paused!important}
.scene *{transform-box:fill-box;transform-origin:center}

/* Seamless payment (hero), 7 s loop: ask, 402, signed payment, data, settle. */
.pay .mv{animation-duration:7s;animation-iteration-count:infinite;animation-timing-function:var(--ease-emph);opacity:0}
.pay .m1{animation-name:pm1}.pay .m2{animation-name:pm2}.pay .m3{animation-name:pm3}.pay .m4{animation-name:pm4}.pay .m5{animation-name:pm5}
@keyframes pm1{0%{transform:translateX(0);opacity:0}2%{opacity:1}14%{transform:translateX(150px);opacity:1}16%,100%{transform:translateX(150px);opacity:0}}
@keyframes pm2{0%,16%{transform:translateX(0);opacity:0}18%{opacity:1}30%{transform:translateX(-150px);opacity:1}32%,100%{transform:translateX(-150px);opacity:0}}
@keyframes pm3{0%,32%{transform:translateX(0);opacity:0}34%{opacity:1}46%{transform:translateX(150px);opacity:1}48%,100%{transform:translateX(150px);opacity:0}}
@keyframes pm4{0%,48%{transform:translateX(0);opacity:0}50%{opacity:1}62%{transform:translateX(-150px);opacity:1}64%,100%{transform:translateX(-150px);opacity:0}}
@keyframes pm5{0%,58%{transform:translateX(0);opacity:0}60%{opacity:1}74%{transform:translateX(150px);opacity:1}76%,100%{transform:translateX(150px);opacity:0}}
.pay .cap{opacity:0;animation:7s infinite var(--ease-std)}
.pay .c1{animation-name:pc1}.pay .c2{animation-name:pc2}.pay .c3{animation-name:pc3}.pay .c4{animation-name:pc4}.pay .c5{animation-name:pc5}
@keyframes pc1{0%,1%{opacity:0}3%,14%{opacity:1}16%,100%{opacity:0}}
@keyframes pc2{0%,16%{opacity:0}18%,30%{opacity:1}32%,100%{opacity:0}}
@keyframes pc3{0%,32%{opacity:0}34%,46%{opacity:1}48%,100%{opacity:0}}
@keyframes pc4{0%,48%{opacity:0}50%,66%{opacity:1}68%,100%{opacity:0}}
@keyframes pc5{0%,60%{opacity:0}62%,94%{opacity:1}97%,100%{opacity:0}}
.pay .glow-a{animation:pga 7s infinite var(--ease-std);opacity:0}
@keyframes pga{0%,62%{opacity:0}64%{opacity:.9}80%,100%{opacity:0}}
.pay .glow-c{animation:pgc 7s infinite var(--ease-std);opacity:0}
@keyframes pgc{0%,74%{opacity:0}76%{opacity:.9}94%,100%{opacity:0}}
.pay .tick{animation:ptk 7s infinite var(--ease-decel);transform:scale(0)}
@keyframes ptk{0%,75%{transform:scale(0)}80%,94%{transform:scale(1)}98%,100%{transform:scale(0)}}
.pay .step{fill:var(--surface-c)}.pay .step-t{fill:var(--on-surface-v);font-size:12px;font-weight:500}
.pay .sx{animation:7s infinite steps(1,end)}
.pay .s1{animation-name:ps1}.pay .s2{animation-name:ps2}.pay .s3{animation-name:ps3}.pay .s4{animation-name:ps4}
@keyframes ps1{0%{fill:var(--primary-container)}16%,100%{fill:var(--surface-c)}}
@keyframes ps2{0%,16%{fill:var(--surface-c)}16.01%{fill:var(--primary-container)}48%,100%{fill:var(--surface-c)}}
@keyframes ps3{0%,48%{fill:var(--surface-c)}48.01%{fill:var(--primary-container)}62%,100%{fill:var(--surface-c)}}
@keyframes ps4{0%,62%{fill:var(--surface-c)}62.01%{fill:var(--primary-container)}97%,100%{fill:var(--surface-c)}}

/* Agents meeting the gateway, some with a verified on-chain identity. */
.agents .flow{stroke-dasharray:6 10;animation:aflow 1.6s linear infinite}
.agents .flow.r{animation-direction:reverse}
@keyframes aflow{to{stroke-dashoffset:-32}}
.agents .badge{animation:abadge 6s infinite var(--ease-decel);transform:scale(0)}
.agents .b2{animation-delay:1.5s}.agents .b3{animation-delay:3s}
@keyframes abadge{0%,8%{transform:scale(0)}16%,80%{transform:scale(1)}90%,100%{transform:scale(0)}}
.agents .hub{animation:ahub 3s infinite var(--ease-std)}
@keyframes ahub{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}

/* Maritime: ships on two lanes over an H3-style density grid, a queue at anchor. */
.sea .water{fill:var(--secondary-container);opacity:.45}
.sea .land{fill:var(--surface-chh)}
.sea .hex{fill:var(--primary);stroke:var(--surface);stroke-width:1}
.sea .hx{animation:hex 4s infinite var(--ease-std)}
.sea .hx1{opacity:.12}.sea .hx2{opacity:.22;animation-delay:.8s}.sea .hx3{opacity:.34;animation-delay:1.6s}.sea .hx4{opacity:.48;animation-delay:2.4s}
@keyframes hex{0%,100%{fill-opacity:1}50%{fill-opacity:.45}}
.sea .ship{fill:var(--on-surface)}
.sea .east{animation:east 16s linear infinite}.sea .east.e2{animation-duration:22s;animation-delay:-9s}
.sea .west{animation:west 19s linear infinite}.sea .west.w2{animation-duration:25s;animation-delay:-12s}
@keyframes east{from{transform:translateX(-60px)}to{transform:translateX(420px)}}
@keyframes west{from{transform:translateX(60px)}to{transform:translateX(-420px)}}
.sea .bob{animation:bob 3s infinite var(--ease-std)}.sea .bob.d1{animation-delay:-1s}.sea .bob.d2{animation-delay:-2s}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
.sea .ping{fill:none;stroke:var(--tertiary);stroke-width:1.5;animation:ping 2.4s infinite var(--ease-decel)}
@keyframes ping{0%{transform:scale(.3);opacity:1}100%{transform:scale(2.2);opacity:0}}

/* Intelligence to an AI trading platform: a live feed becomes history plus forecast. */
.trade .bar{fill:var(--primary)}
.trade .feed{animation:feed 2.2s linear infinite;opacity:0}
.trade .f2{animation-delay:.55s}.trade .f3{animation-delay:1.1s}.trade .f4{animation-delay:1.65s}
@keyframes feed{0%{transform:translateX(0);opacity:0}15%{opacity:1}85%{opacity:1}100%{transform:translateX(96px);opacity:0}}
.trade .grid{stroke:var(--outline-v);stroke-width:1}
.trade .hist{stroke:var(--chart-1);stroke-width:2.5;fill:none;stroke-dasharray:1;stroke-dashoffset:1;animation:draw 6s var(--ease-emph) infinite}
.trade .fc{stroke:var(--chart-2);stroke-width:2.5;fill:none;stroke-dasharray:.03 .02;opacity:0;animation:fcin 6s var(--ease-std) infinite}
.trade .band{fill:var(--chart-2);opacity:0;animation:bandin 6s var(--ease-std) infinite}
@keyframes draw{0%{stroke-dashoffset:1}45%,92%{stroke-dashoffset:0}100%{stroke-dashoffset:0;opacity:0}}
@keyframes fcin{0%,42%{opacity:0}55%,92%{opacity:1}100%{opacity:0}}
@keyframes bandin{0%,42%{opacity:0}55%,92%{opacity:.16}100%{opacity:0}}
.trade .asof{stroke:var(--chart-4);stroke-width:1.5;stroke-dasharray:3 3;animation:asof 6s var(--ease-std) infinite}
@keyframes asof{0%,8%{transform:translateX(0)}45%,100%{transform:translateX(88px)}}
.trade .model{fill:var(--primary-container)}
.trade .spin{animation:spin 3s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
`;

/** Agent ⇄ wearebase ⇄ Base: the x402 round trip, with the session fast path in the caption. */
export function paymentScene(price: string, network: string, id = "pay"): string {
  const pill = (x: number, y: number, w: number, label: string, cls: string) =>
    `<g class="cap ${cls}" transform="translate(${x - w / 2},${y})"><rect width="${w}" height="26" rx="13" class="node"/><text x="${w / 2}" y="17.5" text-anchor="middle" class="t-md">${label}</text></g>`;
  const dot = (x: number, y: number, cls: string, ink: string) => `<g transform="translate(${x},${y})"><g class="mv ${cls}"><circle r="7" class="${ink}"/></g></g>`;
  return `<svg class="scene pay" viewBox="0 66 640 262" role="img" aria-labelledby="${id}-t ${id}-d">
<title id="${id}-t">How an x402 payment flows</title>
<desc id="${id}-d">Your agent asks for data, gets a 402 price, sends a signed USDC payment, receives the data, and the payment settles on ${network}.</desc>
<line x1="138" y1="138" x2="292" y2="138" class="lane"/><line x1="138" y1="182" x2="292" y2="182" class="lane"/><line x1="348" y1="160" x2="502" y2="160" class="lane"/>
<g transform="translate(90,160)"><circle r="58" class="glow-a ink-p" opacity=".15"/><circle r="48" class="node"/>
  <rect x="-22" y="-14" width="44" height="32" rx="10" class="ink-p"/><circle cx="-9" cy="1" r="4.5" fill="#fff"/><circle cx="9" cy="1" r="4.5" fill="#fff"/><rect x="-1.5" y="-25" width="3" height="11" class="ink-p"/><circle cy="-27" r="4.5" class="ink-p"/>
  <text y="70" text-anchor="middle" class="t-md">Your agent</text></g>
<g transform="translate(320,160)"><circle r="48" class="node-p"/>
  <path d="M-16 -14l32 28M16 -14l-32 28" class="stroke-p" stroke-width="6" stroke-linecap="round"/><circle r="4.5" fill="#fff"/>
  <text y="70" text-anchor="middle" class="t-md">wearebase</text></g>
<g transform="translate(550,160)"><circle r="58" class="glow-c ink-t" opacity=".15"/><circle r="48" class="node"/>
  <rect x="-22" y="-22" width="44" height="13" rx="4" class="ink-v" opacity=".35"/><rect x="-22" y="-6" width="44" height="13" rx="4" class="ink-v" opacity=".55"/><rect x="-22" y="10" width="44" height="13" rx="4" class="ink-t"/>
  <text y="70" text-anchor="middle" class="t-md">${network}</text>
  <g transform="translate(30,-30)"><g class="tick"><circle r="11" class="ink-t"/><path d="M-5 0l3.5 3.5L5-4" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/></g></g></g>
${dot(140, 138, "m1", "ink-p")}${dot(290, 182, "m2", "ink-w")}${dot(140, 138, "m3", "ink-t")}${dot(290, 182, "m4", "ink-p")}${dot(350, 160, "m5", "ink-t")}
${pill(215, 84, 140, "GET /forecast", "c1")}${pill(215, 212, 148, `402 · $${price} USDC`, "c2")}${pill(215, 84, 150, "Signed USDC", "c3")}${pill(215, 212, 150, "Data in ~1 ms", "c4")}${pill(425, 98, 150, "Settled on chain", "c5")}
<g transform="translate(92,282)">
  <rect width="104" height="32" rx="16" class="step sx s1"/><text x="52" y="21" text-anchor="middle" class="step-t">1 Ask</text>
  <rect x="116" width="104" height="32" rx="16" class="step sx s2"/><text x="168" y="21" text-anchor="middle" class="step-t">2 Pay</text>
  <rect x="232" width="104" height="32" rx="16" class="step sx s3"/><text x="284" y="21" text-anchor="middle" class="step-t">3 Receive</text>
  <rect x="348" width="104" height="32" rx="16" class="step sx s4"/><text x="400" y="21" text-anchor="middle" class="step-t">4 Settle</text></g>
</svg>`;
}

/** Several agents, each with or without an on-chain identity, trading with the gateway. */
export function agentsScene(): string {
  const agent = (x: number, y: number, label: string, badge: string) => `<g transform="translate(${x},${y})"><circle r="24" class="node"/>
  <rect x="-11" y="-12" width="22" height="16" rx="5" class="ink-p"/><circle cx="-4.5" cy="-4" r="2.2" fill="#fff"/><circle cx="4.5" cy="-4" r="2.2" fill="#fff"/>
  <text y="40" text-anchor="middle" class="t-sm">${label}</text>
  ${badge ? `<g transform="translate(18,-18)"><g class="badge ${badge}"><circle r="9" class="ink-t"/><path d="M-4 0l2.8 2.8L4-3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></g></g>` : ""}</g>`;
  return `<svg class="scene agents" viewBox="0 0 360 230" role="img" aria-labelledby="ag-t ag-d">
<title id="ag-t">Agents interacting with the gateway</title>
<desc id="ag-d">Four AI agents exchange requests and payments with wearebase. Agents with a verified on-chain identity get a check mark and a higher allowance.</desc>
<line x1="62" y1="54" x2="180" y2="112" class="stroke-p flow" stroke-width="2"/><line x1="298" y1="54" x2="180" y2="112" class="stroke-t flow r" stroke-width="2"/>
<line x1="62" y1="170" x2="180" y2="112" class="stroke-t flow" stroke-width="2"/><line x1="298" y1="170" x2="180" y2="112" class="stroke-p flow r" stroke-width="2"/>
<g transform="translate(180,112)"><g class="hub"><circle r="36" class="node-p"/><path d="M-10 -9l20 18M10 -9l-20 18" class="stroke-p" stroke-width="4" stroke-linecap="round"/></g></g>
${agent(62, 54, "Research agent", "b1")}${agent(298, 54, "Trading agent", "b2")}${agent(62, 170, "Logistics agent", "")}${agent(298, 170, "Scheduler", "b3")}
</svg>`;
}

/** Axial hex grid for the maritime scene, with a density class per cell. */
function hexes(): string {
  const out: string[] = [];
  const r = 15;
  const w = Math.sqrt(3) * r;
  // Density follows the two shipping lanes (rows 3 and 4) and peaks at the anchorage (right).
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 12; col++) {
      const cx = 14 + col * w + (row % 2 ? w / 2 : 0);
      const cy = 40 + row * r * 1.5;
      const lane = row === 3 || row === 4 ? 2 : row === 2 || row === 5 ? 1 : 0;
      const anch = col >= 9 && row >= 4 && row <= 6 ? 2 : 0;
      const d = Math.min(4, lane + anch);
      if (d === 0) continue;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 180) * (60 * i - 30);
        return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      out.push(`<polygon points="${pts}" class="hex hx hx${d}"/>`);
    }
  }
  return out.join("");
}

const SHIP = `<path d="M-12 0h20l6-5-6-5h-20z" class="ship"/><rect x="-8" y="-15" width="8" height="5" rx="1" class="ship"/>`;

/** Vessels moving through a strait, binned into density cells, with a queue at anchor. */
export function maritimeScene(): string {
  return `<svg class="scene sea" viewBox="0 0 360 230" role="img" aria-labelledby="sea-t sea-d">
<title id="sea-t">Maritime intelligence</title>
<desc id="sea-d">Ships move through a strait in both directions. Their positions become traffic density cells, and vessels waiting at anchor form a queue.</desc>
<defs><clipPath id="sea-clip"><rect width="360" height="230" rx="18"/></clipPath></defs>
<g clip-path="url(#sea-clip)">
<rect width="360" height="230" class="water"/>
<path d="M0 0h360v26c-40 8-80 14-130 10S120 22 60 30 0 28 0 28z" class="land"/>
<path d="M0 230h360v-26c-50-10-90-4-140 2s-110 6-160-4-60 0-60 0z" class="land"/>
${hexes()}
<g transform="translate(0,96)"><g class="east">${SHIP}</g></g><g transform="translate(0,96)"><g class="east e2">${SHIP}</g></g>
<g transform="translate(360,128)"><g class="west"><g transform="scale(-1,1)">${SHIP}</g></g></g><g transform="translate(360,128)"><g class="west w2"><g transform="scale(-1,1)">${SHIP}</g></g></g>
<g transform="translate(300,160)"><g class="bob"><circle r="4" class="ship"/></g></g><g transform="translate(318,170)"><g class="bob d1"><circle r="4" class="ship"/></g></g><g transform="translate(296,178)"><g class="bob d2"><circle r="4" class="ship"/></g></g>
<g transform="translate(176,112)"><circle r="8" class="ping"/></g>
</g>
<g transform="translate(12,206)"><rect width="128" height="18" rx="9" class="node"/><text x="64" y="12.5" text-anchor="middle" class="t-sm">AIS → density, queues</text></g>
</svg>`;
}

/** A live feed into a trading model: history drawn to an as-of line, then the forecast. */
export function tradingScene(): string {
  const feed = (cls: string, h: number) => `<g transform="translate(20,${118 - h})"><g class="feed ${cls}"><rect width="8" height="${h}" rx="2" class="bar"/></g></g>`;
  return `<svg class="scene trade" viewBox="0 0 360 230" role="img" aria-labelledby="tr-t tr-d">
<title id="tr-t">Intelligence for AI trading platforms</title>
<desc id="tr-d">A live data feed streams into a trading model, which sees point-in-time history up to an as-of line and a forecast with its uncertainty band.</desc>
${feed("f1", 30)}${feed("f2", 46)}${feed("f3", 22)}${feed("f4", 38)}
<g transform="translate(150,96)"><circle r="28" class="model"/><g class="spin"><path d="M0-23a23 23 0 0 1 23 23" class="stroke-p" stroke-width="3" stroke-linecap="round"/></g><text y="4" text-anchor="middle" class="t-sm ink-on-p">model</text></g>
<g transform="translate(196,28)">
  <line x1="0" y1="0" x2="0" y2="150" class="grid"/><line x1="0" y1="150" x2="150" y2="150" class="grid"/><line x1="0" y1="100" x2="150" y2="100" class="grid" opacity=".5"/><line x1="0" y1="50" x2="150" y2="50" class="grid" opacity=".5"/>
  <path d="M90 82 L120 66 L150 74 L150 112 L120 104 L90 96 Z" class="band"/>
  <path d="M0 120 L15 104 L30 112 L45 86 L60 94 L75 70 L90 88" pathLength="1" class="hist"/>
  <path d="M90 88 L105 78 L120 85 L135 72 L150 92" pathLength="1" class="fc"/>
  <g transform="translate(-38,0)"><line x1="40" y1="0" x2="40" y2="150" class="asof"/></g>
</g>
<g transform="translate(196,190)"><text class="t-sm">history · as_of · forecast</text></g>
<g transform="translate(12,170)"><rect width="128" height="40" rx="12" class="node"/><text x="64" y="17" text-anchor="middle" class="t-sm">AI trading platform</text><text x="64" y="32" text-anchor="middle" class="t-sm">live stream + history</text></g>
</svg>`;
}
