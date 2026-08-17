// Inline synonym popup: right-click or double-click a word in the translation to
// get word options — locked glossary terms + instant offline thesaurus + Claude's
// in-context picks (delivered over SSE, no chat). Click an option to replace.
import { currentBook } from "./api.js";

let pop = null;
let cur = null; // { el, info, word, reqId, saveFn }
let claudeTimer = null;

export function initSynonyms({ onReplace }) {
  cur_save = onReplace;
  document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target)) close(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("resize", close);
}
let cur_save = () => {};

/* ---- triggers wired from main.js ---- */
export function synonymsFromPoint(el, x, y) {
  const info = wordAtPoint(x, y);
  if (info && info.word) open(el, info, x, y);
}
export function synonymsFromSelection(el) {
  const sel = window.getSelection();
  const word = sel.toString().trim();
  if (!word || /\s/.test(word)) return false;
  const range = sel.getRangeAt(0);
  const info = { node: sel.anchorNode, start: Math.min(sel.anchorOffset, sel.focusOffset),
    end: Math.max(sel.anchorOffset, sel.focusOffset), word };
  if (info.node.nodeType !== 3) return false;
  const r = range.getBoundingClientRect();
  open(el, info, r.left, r.bottom);
  return true;
}

/* ---- the popup ---- */
async function open(el, info, x, y) {
  close();
  cur = { el, info, word: info.word, segId: el.dataset.id, reqId: "r" + Math.round(performance.now()) };

  pop = document.createElement("div");
  pop.className = "synpop";
  pop.innerHTML = `<div class="synpop__head"><span>“${esc(info.word)}”</span><button class="synpop__x" aria-label="Close">×</button></div>
    <div class="synpop__body"><div class="synpop__loading">Looking up…</div></div>`;
  document.body.appendChild(pop);
  pop.querySelector(".synpop__x").addEventListener("click", close);
  position(x, y);

  // instant: glossary + offline thesaurus
  let data = { glossary: [], thesaurus: [] };
  try {
    const r = await fetch(`/api/synonyms?word=${encodeURIComponent(info.word)}&book=${encodeURIComponent(currentBook())}`);
    data = await r.json();
  } catch {}
  if (!cur) return;
  renderBody(data);

  // async: Claude in context (no chat) — straight to the popup
  askClaude(el, info);
}

function renderBody(data, claude) {
  if (!pop) return;
  const body = pop.querySelector(".synpop__body");
  const parts = [];

  if (data.glossary && data.glossary.length) {
    parts.push(`<div class="synpop__sec"><div class="synpop__lbl">Glossary${data.glossary[0].status ? " · locked" : ""}</div>`);
    for (const g of data.glossary) {
      parts.push(`<div class="synpop__gloss"><span class="synpop__cz">${esc(g.source || g.czech || "")}</span>${g.status ? `<span class="synpop__lock">${esc(g.status)}</span>` : ""}</div>`);
      parts.push(`<div class="synpop__chips">${chips(g.alternatives, "glossary")}</div>`);
      if (g.note) parts.push(`<div class="synpop__note">${esc(g.note)}</div>`);
    }
    parts.push(`</div>`);
  }

  parts.push(`<div class="synpop__sec"><div class="synpop__lbl">Thesaurus</div>` +
    (data.thesaurus && data.thesaurus.length ? `<div class="synpop__chips">${chips(data.thesaurus, "thesaurus")}</div>` : `<div class="synpop__empty">no offline matches</div>`) + `</div>`);

  parts.push(`<div class="synpop__sec" id="synClaude"><div class="synpop__lbl">Claude · in context</div>` +
    (claude === undefined ? `<div class="synpop__pending">asking Claude…</div>`
      : claude === null ? `<div class="synpop__empty">Claude offline — start a Claude Code session for in-context picks.</div>`
        : `<div class="synpop__chips">${chips(claude, "claude")}</div>`) + `</div>`);

  body.innerHTML = parts.join("");
  body.querySelectorAll(".synchip").forEach((c) => c.addEventListener("click", () => replaceWith(c.dataset.w, c.dataset.src)));
}

function chips(arr, src) {
  return (arr || []).filter(Boolean).map((w) => {
    const t = typeof w === "string" ? w : (w.text || "");
    return `<button class="synchip" data-w="${esc(t)}" data-src="${esc(src || "")}">${esc(t)}</button>`;
  }).join("");
}

function askClaude(el, info) {
  clearTimeout(claudeTimer);
  fetch(`/api/synonyms/ask?book=${encodeURIComponent(currentBook())}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: info.word, segmentId: el.dataset.id, context: el.textContent, reqId: cur.reqId }),
  }).catch(() => {});
  claudeTimer = setTimeout(() => updateClaude(null), 7000);
}

// called by main.js when an SSE "synonyms" event arrives
export function onSynonymsEvent(data) {
  if (!cur || !pop) return;
  if (String(data.word || "").toLowerCase() !== cur.word.toLowerCase()) return;
  clearTimeout(claudeTimer);
  updateClaude(data.options || []);
}

function updateClaude(options) {
  const sec = pop && pop.querySelector("#synClaude");
  if (!sec) return;
  sec.innerHTML = `<div class="synpop__lbl">Claude · in context</div>` +
    (options && options.length ? `<div class="synpop__chips">${chips(options, "claude")}</div>`
      : `<div class="synpop__empty">Claude offline — start a Claude Code session for in-context picks.</div>`);
  sec.querySelectorAll(".synchip").forEach((c) => c.addEventListener("click", () => replaceWith(c.dataset.w, c.dataset.src)));
}

function replaceWith(replacement, source) {
  if (!cur) return;
  const { el, info, word } = cur;
  // preserve leading capitalisation
  let repl = replacement;
  if (word[0] && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase())
    repl = repl.charAt(0).toUpperCase() + repl.slice(1);

  // the word-level preference signal: which word was swapped, for what, from where,
  // and which alternatives were on offer at the moment of choice.
  const shownAlternatives = pop
    ? [...pop.querySelectorAll(".synchip")].map((c) => c.dataset.w).filter((w) => w && w !== replacement)
    : [];
  const meta = { origin: "synonym", synonym: { word, replacement, source: source || "", shownAlternatives } };

  const full = el.textContent;
  const g = offsetInEl(el, info.node, info.start);
  const newText = full.slice(0, g) + repl + full.slice(g + word.length);
  el.textContent = newText;
  if (newText.trim()) delete el.dataset.ph;
  cur_save(el.dataset.id, newText.replace(/\s+/g, " ").trim(), el, meta);
  close();
}

/* ---- helpers ---- */
function offsetInEl(el, node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) { if (n === node) return total + offset; total += n.textContent.length; }
  return offset;
}
function caretFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r; } }
  return null;
}
function wordAtPoint(x, y) {
  const r = caretFromPoint(x, y);
  if (!r) return null;
  const node = r.startContainer;
  if (node.nodeType !== 3) return null;
  const text = node.textContent;
  const isW = (c) => /[\p{L}\p{M}'’-]/u.test(c || "");
  let s = r.startOffset, e = r.startOffset;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  if (s === e) return null;
  return { node, start: s, end: e, word: text.slice(s, e) };
}
function position(x, y) {
  const w = 280, vh = window.innerHeight, vw = window.innerWidth;
  pop.style.left = Math.min(x, vw - w - 12) + "px";
  pop.style.top = Math.min(y + 6, vh - 40) + "px";
  // if it would overflow bottom, flip above after render
  requestAnimationFrame(() => {
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    if (r.bottom > vh - 8) pop.style.top = Math.max(8, y - r.height - 8) + "px";
  });
}
function close() { clearTimeout(claudeTimer); if (pop) pop.remove(); pop = null; cur = null; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
