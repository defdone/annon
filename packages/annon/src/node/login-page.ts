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
<section class="act"><div id="wallet-field" class="field" hidden><span class="label" id="near-wallet-label">NEAR wallet</span><div class="picker"><div id="near-wallet" class="picker-button" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-controls="near-wallet-list" aria-labelledby="near-wallet-label near-wallet-value"><span id="near-wallet-value">Meteor Wallet</span></div><ul id="near-wallet-list" class="picker-list" role="listbox" aria-labelledby="near-wallet-label" hidden><li id="near-wallet-meteor" class="option" role="option" aria-selected="true">Meteor Wallet<span class="option-note">Extension or web popup</span></li><li id="near-wallet-hot" class="option" role="option" aria-selected="false">HOT Wallet<span class="option-note">Mainnet only</span></li></ul></div></div><div class="buttons"><button id="approve" class="primary" disabled>Review in wallet</button><button id="cancel" class="secondary" hidden>Cancel</button></div><p id="status" class="status" role="status" aria-live="polite"></p></section>
<details class="details"><summary>Technical details</summary><pre id="action"></pre></details>
</main></body></html>`;

export const LOGIN_PAGE_CSS = `:root{--paper:#FAF8F2;--alt:#F1EDE3;--ink:#111111;--soft:#2E2C28;--muted:#4A4741;--line:#D9D3C7;--red:#B3261E;--serif:Newsreader,"Iowan Old Style",Georgia,serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;border-radius:0}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--serif);-webkit-text-size-adjust:100%}
.card{max-width:640px;margin:0 auto;padding:40px 16px 56px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.mark{fill:var(--ink);flex:none}
.eyebrow,.label,dt,.details summary,button{font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;font-size:12px}
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
.picker{position:relative;flex:0 1 20em;min-width:0}
.picker-button{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--paper);color:var(--ink);border:1px solid var(--ink);padding:10px 12px;cursor:pointer;font:14px/1.4 var(--mono);user-select:none}
.picker-button::after{content:"";width:0;height:0;border:5px solid transparent;border-top-color:var(--ink);border-bottom:0;flex:none}
.picker-button[aria-expanded="true"]::after{border-top:0;border-bottom:5px solid var(--ink)}
.picker-button[aria-disabled="true"]{opacity:.4;cursor:not-allowed}
.picker-list{position:absolute;z-index:2;left:0;right:0;top:100%;margin:0;padding:0;list-style:none;background:var(--paper);border:1px solid var(--ink);border-top:0}
.option{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:10px 12px;cursor:pointer;font:14px/1.4 var(--mono);color:var(--soft)}
.option+.option{border-top:1px solid var(--line)}
.option.active{background:var(--alt);color:var(--ink)}
.option[aria-selected="true"]{color:var(--ink);font-weight:600}
.option[aria-selected="true"]::before{content:"";width:6px;height:6px;background:var(--ink);flex:none;align-self:center}
.option[aria-disabled="true"]{color:var(--muted);cursor:not-allowed;opacity:.6}
.option-note{margin-left:auto;font-size:11px;font-weight:400;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.buttons{display:flex;flex-wrap:wrap;gap:12px}
button{padding:14px 22px;border:1px solid var(--ink);cursor:pointer}
.primary{background:var(--ink);color:var(--paper)}
.secondary{background:transparent;color:var(--ink)}
button:disabled{cursor:not-allowed;opacity:.4}
button:focus-visible,.picker-button:focus-visible,summary:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.status{min-height:1.5em;margin:16px 0 0;color:var(--soft)}
.status.wait{color:var(--muted)}
.status.ok{color:var(--ink);border-left:3px solid var(--ink);padding-left:12px}
.status.error{color:var(--red);border-left:3px solid var(--red);padding-left:12px}
.details{margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
.details summary{cursor:pointer;color:var(--muted);padding:6px 0}
.details pre{margin-top:10px}
[hidden]{display:none!important}
@media (max-width:480px){.row{grid-template-columns:1fr}.card{padding-top:28px}button{flex:1 1 100%}.picker{flex-basis:100%}}
`;
