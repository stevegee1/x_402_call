/**
 * Material 3 design tokens and components for every browser page we serve (the public site and the
 * customer account pages). Plain CSS, no third-party fonts: the type stack prefers Google Sans and
 * Roboto where the visitor has them and falls back to the system UI font, so nothing is fetched
 * from another origin and the pages keep a hash-only CSP.
 *
 * Colour roles follow the M3 baseline scheme (primary #0b57d0); motion uses the M3 emphasized and
 * standard easing curves. Every animation stops under prefers-reduced-motion.
 */
export const THEME_CSS = `
:root{color-scheme:light dark;
--primary:#0b57d0;--on-primary:#fff;--primary-container:#d3e3fd;--on-primary-container:#041e49;
--secondary-container:#c2e7ff;--on-secondary-container:#001d35;
--tertiary:#146c2e;--tertiary-container:#c4eed0;--on-tertiary-container:#072711;
--warn-container:#ffdf99;--on-warn-container:#574000;--error:#b3261e;--error-container:#f9dedc;--on-error-container:#410e0b;
--surface:#fff;--surface-dim:#f8fafd;--surface-c:#f0f4f9;--surface-ch:#e9eef6;--surface-chh:#dde3ea;
--on-surface:#1f1f1f;--on-surface-v:#444746;--outline:#747775;--outline-v:#c4c7c5;
--chart-1:#0b57d0;--chart-2:#146c2e;--chart-3:#b3261e;--chart-4:#a142f4;
--shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15);
--ease-emph:cubic-bezier(.2,0,0,1);--ease-std:cubic-bezier(.2,0,0,1);--ease-decel:cubic-bezier(.05,.7,.1,1);
--font:"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
--font-display:"Google Sans Display","Google Sans",Roboto,"Segoe UI",system-ui,-apple-system,sans-serif;
--mono:"Google Sans Mono","Roboto Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--primary:#a8c7fa;--on-primary:#062e6f;--primary-container:#0842a0;--on-primary-container:#d3e3fd;
--secondary-container:#004a77;--on-secondary-container:#c2e7ff;
--tertiary:#6dd58c;--tertiary-container:#0f5223;--on-tertiary-container:#c4eed0;
--warn-container:#574000;--on-warn-container:#ffdf99;--error:#f2b8b5;--error-container:#8c1d18;--on-error-container:#f9dedc;
--surface:#131314;--surface-dim:#1b1b1c;--surface-c:#1e1f20;--surface-ch:#282a2c;--surface-chh:#333537;
--on-surface:#e3e3e3;--on-surface-v:#c4c7c5;--outline:#8e918f;--outline-v:#444746;
--chart-1:#a8c7fa;--chart-2:#6dd58c;--chart-3:#f2b8b5;--chart-4:#d7aefb;
--shadow:0 1px 2px rgba(0,0,0,.5),0 1px 3px 1px rgba(0,0,0,.3)}}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;scroll-padding-top:80px}
body{margin:0;background:var(--surface);color:var(--on-surface);font:400 16px/1.6 var(--font)}
a{color:var(--primary)}
:focus-visible{outline:3px solid var(--primary);outline-offset:2px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--surface);padding:8px 16px;z-index:10}
.banner{background:var(--primary-container);color:var(--on-primary-container);font-size:14px;padding:8px 24px;text-align:center}
/* Top app bar */
.appbar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:saturate(1.6) blur(12px);-webkit-backdrop-filter:saturate(1.6) blur(12px);border-bottom:1px solid var(--outline-v)}
.appbar .wrap{display:flex;align-items:center;gap:24px;min-height:64px}
.brand{display:flex;align-items:center;gap:10px;font:500 20px/1 var(--font-display);color:var(--on-surface);text-decoration:none;letter-spacing:-.2px}
.brand svg{flex:none}
.appbar nav{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}
.appbar nav a{color:var(--on-surface-v);text-decoration:none;font-size:14px;font-weight:500;padding:8px 12px;border-radius:999px;transition:background .2s var(--ease-std),color .2s var(--ease-std)}
.appbar nav a:hover{background:var(--surface-ch);color:var(--on-surface)}
.appbar .acts{display:flex;gap:8px}
/* Buttons (M3 filled, tonal, outlined, text) */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 24px;border-radius:999px;font:500 14px/1 var(--font);letter-spacing:.1px;text-decoration:none;cursor:pointer;border:1px solid transparent;transition:box-shadow .2s var(--ease-std),background .2s var(--ease-std),transform .2s var(--ease-std);white-space:nowrap}
.btn.filled{background:var(--primary);color:var(--on-primary)}.btn.filled:hover{box-shadow:var(--shadow)}
.btn.tonal{background:var(--secondary-container);color:var(--on-secondary-container)}.btn.tonal:hover{box-shadow:var(--shadow)}
.btn.outlined{background:transparent;color:var(--primary);border-color:var(--outline)}.btn.outlined:hover{background:color-mix(in srgb,var(--primary) 8%,transparent)}
.btn.text{background:transparent;color:var(--primary);padding:0 12px}.btn.text:hover{background:color-mix(in srgb,var(--primary) 8%,transparent)}
.btn.lg{height:48px;padding:0 28px;font-size:15px}
.btn:active{transform:scale(.98)}
.btn[disabled]{opacity:.38;cursor:default;box-shadow:none}
/* Type */
h1,h2,h3{font-family:var(--font-display);color:var(--on-surface)}
h1{font-size:clamp(40px,6.2vw,64px);line-height:1.08;font-weight:400;letter-spacing:-1px;margin:0 0 20px}
h2{font-size:clamp(28px,3.6vw,40px);line-height:1.2;font-weight:400;letter-spacing:-.4px;margin:0 0 12px}
h3{font-size:20px;line-height:1.35;font-weight:500;margin:0 0 6px}
.overline{display:inline-block;font:500 13px/1 var(--font);letter-spacing:.6px;text-transform:uppercase;color:var(--primary);margin-bottom:14px}
.lede{font-size:clamp(17px,1.6vw,20px);line-height:1.55;color:var(--on-surface-v);margin:0 0 32px;max-width:640px}
.sub{color:var(--on-surface-v);margin:0 0 32px;max-width:720px}
.muted{color:var(--on-surface-v)}
code,pre{font-family:var(--mono);font-size:14px}
pre{background:var(--surface-c);border:1px solid var(--outline-v);border-radius:16px;padding:16px 20px;overflow-x:auto;margin:0 0 20px;line-height:1.55}
/* Surfaces */
.card{background:var(--surface-dim);border:1px solid var(--outline-v);border-radius:24px;padding:28px;min-width:0}
.card.filled{background:var(--surface-c);border-color:transparent}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;border-radius:8px;padding:0 12px;font:500 13px/1 var(--font)}
.chip.ok{background:var(--tertiary-container);color:var(--on-tertiary-container)}
.chip.warn{background:var(--warn-container);color:var(--on-warn-container)}
.chip.info{background:var(--primary-container);color:var(--on-primary-container)}
.chip .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.chip.ok .dot{animation:pulse 2s var(--ease-std) infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
/* Forms (M3 outlined text fields) */
.field{display:grid;gap:6px;margin:0 0 18px;align-content:start}
.field label{font:500 14px/1.3 var(--font);color:var(--on-surface)}
.field input,.field select{height:52px;border:1px solid var(--outline);border-radius:8px;background:var(--surface);color:var(--on-surface);padding:0 16px;font:400 16px/1 var(--font);width:100%;transition:border-color .2s var(--ease-std),box-shadow .2s var(--ease-std)}
.field input:focus,.field select:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}
.field .hint{font-size:13px;color:var(--on-surface-v)}
.field.invalid input{border-color:var(--error);box-shadow:0 0 0 1px var(--error)}
.alert{border-radius:12px;padding:12px 16px;margin:0 0 20px;font-size:14px}
.alert.error{background:var(--error-container);color:var(--on-error-container)}
.alert.ok{background:var(--tertiary-container);color:var(--on-tertiary-container)}
.alert.info{background:var(--primary-container);color:var(--on-primary-container)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:500;color:var(--on-surface-v)}
th,td{padding:12px 16px 12px 0;border-top:1px solid var(--outline-v);vertical-align:top}
td.num,th.num{white-space:nowrap;font-variant-numeric:tabular-nums}td code{white-space:nowrap}
.scroll{overflow-x:auto}
footer{border-top:1px solid var(--outline-v);padding:40px 0 56px;font-size:14px;color:var(--on-surface-v)}
footer nav{display:flex;flex-wrap:wrap;gap:8px 24px;margin-bottom:12px}footer a{color:var(--on-surface-v)}
@media (max-width:860px){.appbar nav{display:none}.appbar .acts{margin-left:auto}}
@media (max-width:640px){.wrap{padding:0 16px}.card{padding:20px;border-radius:20px}
table.stack thead{display:none}table.stack,table.stack tbody,table.stack tr,table.stack td{display:block}table.stack tr{border-top:1px solid var(--outline-v);padding:12px 0}table.stack td{border:0;padding:2px 0}table.stack td code{white-space:normal;overflow-wrap:anywhere}table.stack td.num{display:inline-block;margin-right:16px;font-weight:500}table.stack td.num::before{content:attr(data-label) " ";font-weight:400;color:var(--on-surface-v)}
.appbar .acts .btn.text{display:none}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/** The wearebase mark: a rounded tile with a stylised relay "x" (agent ⇄ data). */
export const BRAND_MARK = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#0b57d0"/><path d="M9 10l14 12M23 10L9 22" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="2.6" fill="#c2e7ff"/></svg>`;

export const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0b57d0"/><path d="M9 10l14 12M23 10L9 22" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="2.6" fill="#c2e7ff"/></svg>')}`;

export const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
