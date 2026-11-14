/**
 * The approval page shell and its stylesheet. Both are static: the page script fills in every
 * request value as text. The stylesheet is served from the page's own origin (`style-src 'self'`),
 * with no inline styles, web fonts or other resources.
 */

/** A small arch: the Annon mark. Inline SVG, so it needs no image source. */
const MARK =
  '<svg class="mark" viewBox="0 0 24 28" width="22" height="26" aria-hidden="true"><path d="M2 27V12a10 10 0 0 1 20 0v15h-5V12a5 5 0 0 0-10 0v15z"/></svg>';

export const LOGIN_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Annon wallet approval</title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head><body><main class="card">
<header class="brand">${MARK}<p class="eyebrow">ANNON CLI</p></header>
<h1 id="title">Waiting for the CLI</h1>
<section class="pair" aria-labelledby="pair-label"><p class="label" id="pair-label">Pairing code</p><p id="pair" class="code">------</p><p class="hint">Check that your terminal shows the same code.</p></section>
<section id="summary" class="summary" hidden><p id="amount" class="amount" hidden></p><dl id="rows" class="rows"></dl><div id="message-box" class="message" hidden><p id="message-label" class="label"></p><pre id="message"></pre></div><ul id="warnings" class="warnings" hidden></ul><div id="terms-box" class="terms" hidden><p class="label">Terms from the CLI</p><p class="hint">For review. Your wallet signs only the request above.</p><dl id="terms" class="rows"></dl></div><p id="note" class="note"></p></section>
<section class="act"><p id="wallet-field" class="field" hidden><label for="near-wallet">NEAR wallet</label><select id="near-wallet"><option value="meteor-wallet">Meteor Wallet</option><option id="near-wallet-hot" value="hot-wallet">HOT Wallet (mainnet)</option></select></p><div class="buttons"><button id="approve" class="primary" disabled>Review in wallet</button><button id="cancel" class="secondary" hidden>Cancel</button></div><p id="status" class="status" role="status" aria-live="polite"></p></section>
<details class="details"><summary>Technical details</summary><pre id="action"></pre></details>
</main></body></html>`;

export const LOGIN_PAGE_CSS = `:root{--paper:#FAF8F2;--alt:#F1EDE3;--ink:#111111;--soft:#2E2C28;--muted:#4A4741;--line:#D9D3C7;--red:#B3261E;--serif:Newsreader,"Iowan Old Style",Georgia,serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;border-radius:0}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--serif);-webkit-text-size-adjust:100%}
.card{max-width:640px;margin:0 auto;padding:40px 16px 56px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.mark{fill:var(--ink);flex:none}
.eyebrow,.label,dt,.details summary,button,select,label{font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;font-size:12px}
.eyebrow{margin:0;color:var(--soft)}
h1{font-weight:500;font-size:clamp(28px,6vw,36px);line-height:1.15;margin:0 0 24px;letter-spacing:-.01em}
.label{margin:0 0 6px;color:var(--muted)}
.hint{margin:6px 0 0;color:var(--muted);font-size:15px}
.pair{border:1px solid var(--ink);background:var(--alt);padding:16px 20px;margin-bottom:28px}
.code{margin:0;font:600 clamp(30px,9vw,40px)/1.1 var(--mono);letter-spacing:.18em;word-break:break-all}
.summary{border-top:1px solid var(--line);padding-top:20px}
.amount{margin:0 0 12px;font-size:clamp(30px,8vw,42px);line-height:1.1}
.rows{margin:0}
.row{display:grid;grid-template-columns:minmax(0,11em) minmax(0,1fr);gap:4px 16px;padding:9px 0;border-bottom:1px solid var(--line)}
dt{color:var(--muted);padding-top:3px}
dd{margin:0;color:var(--soft);overflow-wrap:anywhere}
dd.mono{font:14px/1.5 var(--mono)}
.message,.terms{margin-top:20px}
pre{margin:0;padding:14px 16px;background:var(--alt);border:1px solid var(--line);font:13px/1.55 var(--mono);color:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere;max-height:22em;overflow:auto}
.warnings{margin:20px 0 0;padding:12px 16px 12px 32px;border:1px solid var(--red);color:var(--red)}
.note{margin:20px 0 0;color:var(--soft)}
.act{margin-top:28px;border-top:1px solid var(--line);padding-top:20px}
.field{margin:0 0 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
label{color:var(--muted)}
select{appearance:none;-webkit-appearance:none;background:var(--paper) linear-gradient(45deg,transparent 50%,var(--ink) 50%) no-repeat right 14px center/6px 6px;color:var(--ink);border:1px solid var(--ink);padding:10px 36px 10px 12px;min-width:16em;max-width:100%}
.buttons{display:flex;flex-wrap:wrap;gap:12px}
button{padding:14px 22px;border:1px solid var(--ink);cursor:pointer}
.primary{background:var(--ink);color:var(--paper)}
.secondary{background:transparent;color:var(--ink)}
button:disabled{cursor:not-allowed;opacity:.4}
button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.status{min-height:1.5em;margin:16px 0 0;color:var(--soft)}
.status.wait{color:var(--muted)}
.status.ok{color:var(--ink);border-left:3px solid var(--ink);padding-left:12px}
.status.error{color:var(--red);border-left:3px solid var(--red);padding-left:12px}
.details{margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
.details summary{cursor:pointer;color:var(--muted);padding:6px 0}
.details pre{margin-top:10px}
[hidden]{display:none!important}
@media (max-width:480px){.row{grid-template-columns:1fr}.card{padding-top:28px}button{flex:1 1 100%}select{min-width:0;width:100%}}
`;
