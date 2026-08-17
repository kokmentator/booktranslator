// Translation Desk — multi-book. Renders the two leaves, stitches selections
// across the seam, keeps the panes scroll-synced, reports position, saves inline
// edits, drives the inspector, and switches between books.
import { getProject, patchSegment, getBooks, currentBook, exportBook, translateChapter, translateSegment } from "./api.js";
import { initZoom } from "./zoom.js";
import { initInspector, setActive as inspectorSetActive, onServerEvent, activateChat } from "./inspector.js";
import { initSynonyms, synonymsFromPoint, synonymsFromSelection, onSynonymsEvent } from "./synonyms.js";
import { initSettings, openSettings } from "./settings.js";
import { initLibrary, openLibrary } from "./library.js";

const left = document.getElementById("left");
const right = document.getElementById("right");
const seam = document.getElementById("seam");
const positionEl = document.getElementById("position");
const chapterSelect = document.getElementById("chapterSelect");
const bookbar = document.getElementById("bookbar");
const titleTargetEl = document.getElementById("titleTarget");
const titleSourceEl = document.getElementById("titleSource");
const hintEl = document.getElementById("hint");

let project = null;
const targetById = new Map();
const sourceById = new Map();
const chapterById = new Map();
const elById = { left: new Map(), right: new Map() };
const segEls = { left: [], right: [] };
const chTotals = { left: {}, right: {} };
let activePane = "left";

init();

async function init() {
  initZoom();
  initSettings();
  initLibrary();
  initUsage();
  initSaveBox();
  await renderBookTabs();
  try {
    project = await getProject();
  } catch (e) {
    hintEl.textContent = "Could not load the book — is the server running?";
    return;
  }
  targetById.clear(); sourceById.clear(); chapterById.clear();
  project.targetSegments.forEach((s) => targetById.set(s.id, s));
  project.sourceSegments.forEach((s) => sourceById.set(s.id, s));
  project.chapters.forEach((c) => chapterById.set(c.id, c));

  // titleTarget/titleSource are current; titleEn/titleCs still read for older projects.
  const tTarget = project.book.titleTarget || project.book.titleEn || "Untitled";
  const tSource = project.book.titleSource || project.book.titleCs || "";
  document.title = `${tTarget} — Translation Desk`;
  titleTargetEl.textContent = tTarget;
  titleSourceEl.textContent = tSource;
  document.querySelector(".masthead__sep").hidden = !tSource;

  // Label the two panes with the book's language pair (resolved by the server).
  const langs = project.book.languages || {};
  const tabT = document.querySelector(".leaf--target .leaf__tab");
  const tabS = document.querySelector(".leaf--source .leaf__tab");
  if (tabT) tabT.textContent = `Translation · ${langs.target?.name || "Target"}`;
  if (tabS) tabS.textContent = `Original · ${langs.source?.name || "Source"}`;

  renderChapterSelect();
  renderPane(left, project.targetSegments, "target");
  renderPane(right, project.sourceSegments, "source");
  cacheSegEls();
  initInspector({
    applyToEditor: applySegmentUpdate,
    chapterLabel: (id) => chapterById.get(id)?.label || "",
  });
  initSynonyms({ onReplace: saveReplacement });
  wireSelection();
  wireScrollSync();
  wireExport();
  wireTranslateChapter();
  initSearch();
  initJumpUntranslated();
  connectEvents();
  updatePosition();
  updateProgress();
}

/* --------------------- search across both texts --------------------- */
function initSearch() {
  const bar = document.getElementById("searchbar"), input = document.getElementById("searchInput");
  const count = document.getElementById("searchCount");
  if (!bar) return;
  let hits = [], at = -1, lastQuery = "";

  const open = () => { bar.hidden = false; input.focus(); input.select(); };
  const close = () => { bar.hidden = true; clearMark(); hits = []; at = -1; count.textContent = ""; };
  const clearMark = () => document.querySelectorAll(".search-hit").forEach((el) => el.classList.remove("search-hit"));

  function collect(qRaw) {
    const q = qRaw.trim().toLowerCase();
    hits = []; at = -1; clearMark();
    if (q.length < 2) { count.textContent = ""; return; }
    const scan = (map, paneKey) => {
      for (const [id, seg] of map) {
        const text = paneKey === "left" ? (seg.targetText || "") : (seg.text || "");
        if (text.toLowerCase().includes(q)) hits.push({ id, paneKey });
      }
    };
    scan(targetById, "left");
    scan(sourceById, "right");
    count.textContent = hits.length ? `0/${hits.length}` : "0 matches";
  }

  function go(dir) {
    if (!hits.length) return;
    at = (at + dir + hits.length) % hits.length;
    clearMark();
    const h = hits[at];
    const el = elById[h.paneKey].get(h.id);
    if (el) {
      el.classList.add("search-hit");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    count.textContent = `${at + 1}/${hits.length}`;
  }

  input.addEventListener("input", () => { lastQuery = input.value; collect(lastQuery); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  document.getElementById("searchNext").addEventListener("click", () => go(1));
  document.getElementById("searchPrev").addEventListener("click", () => go(-1));
  document.getElementById("searchClose").addEventListener("click", close);
  document.getElementById("searchBtn")?.addEventListener("click", open);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); open(); }
  });
}

/* --------------- jump to next untranslated / flagged ----------------- */
function initJumpUntranslated() {
  const btn = document.getElementById("jumpUntranslated");
  if (!btn) return;
  const jump = () => {
    const open = project.targetSegments.filter((s) =>
      s.kind === "body" && (s.status === "untranslated" || s.status === "flagged" || !(s.targetText || "").trim()));
    if (!open.length) { hintEl.textContent = "Nothing left — every paragraph has a translation. 🎉"; return; }
    // next one below the current viewport centre, else wrap to the first
    const mid = left.scrollTop + left.clientHeight / 2;
    const next = open.find((s) => {
      const el = elById.left.get(s.id);
      return el && el.offsetTop > mid;
    }) || open[0];
    const el = elById.left.get(next.id);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("search-hit");
      setTimeout(() => el.classList.remove("search-hit"), 1600);
    }
    hintEl.textContent = `${open.length} paragraph${open.length === 1 ? "" : "s"} still untranslated or flagged.`;
  };
  btn.addEventListener("click", jump);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "j") { e.preventDefault(); jump(); }
  });
}

/* ----------------- book progress in the masthead --------------------- */
function updateProgress() {
  const box = document.getElementById("bookProgress");
  const bar = document.getElementById("bookProgressBar");
  const txt = document.getElementById("bookProgressText");
  if (!box || !project) return;
  const bodies = project.targetSegments.filter((s) => s.kind === "body");
  if (!bodies.length) { box.hidden = true; return; }
  const done = bodies.filter((s) => s.status !== "untranslated" && (s.targetText || "").trim()).length;
  const pct = Math.round((done / bodies.length) * 100);
  box.hidden = false;
  bar.style.width = pct + "%";
  txt.textContent = `${pct}%`;
  box.title = `${done} of ${bodies.length} paragraphs translated (${pct}%)`;
}

/* ----------------- save indicator + hard Save button ---------------- */
// Autosave is real (Enter / click away → PATCH), but people trust a button.
// The light reports what actually happened: api.js announces every persisting
// call; the button force-commits the paragraph being typed right now.
function initSaveBox() {
  const state = document.getElementById("saveState");
  const btn = document.getElementById("saveNow");
  if (!state) return;
  let dirty = false;
  const fmt = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const set = (cls, text) => { state.className = "savebox__state " + cls; state.innerHTML = `<i class="savebox__dot"></i>${text}`; };

  window.addEventListener("bt:save", (e) => {
    if (e.detail === "saving") set("is-saving", "Saving…");
    else if (e.detail === "saved") { dirty = false; set("is-saved", `All saved · ${fmt()}`); }
    else set("is-error", "⚠ Save failed — check the server, then press Save");
  });
  // typing in a paragraph → honest "not committed yet" state
  left.addEventListener("input", (e) => {
    if (e.target.closest?.(".seg")) { dirty = true; set("is-dirty", "Editing — Enter or Save commits"); }
  });

  btn?.addEventListener("click", () => {
    const active = document.activeElement;
    if (active && active.closest?.(".seg,#left") && active.isContentEditable) {
      active.blur(); // blur handler PATCHes the pending edit → events update the light
    } else if (dirty) {
      // an edited paragraph lost focus without committing (shouldn't happen, but belt & braces)
      set("is-saving", "Saving…");
      document.querySelectorAll("#left .seg").forEach((el) => el.blur());
      setTimeout(() => { if (dirty) set("is-saved", `All saved · ${fmt()}`); }, 400);
    } else {
      set("is-saved", `All saved · ${fmt()}`); // nothing pending — reassure
    }
  });
}

/* -------------------- AI usage counter (statusbar) ----------------- */
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function renderUsageCounter(u) {
  const el = document.getElementById("usageCounter");
  if (!el || !u) return;
  const tok = (u.inputTokens || 0) + (u.outputTokens || 0);
  el.hidden = !(u.calls > 0);
  el.textContent = `⛁ ${fmtTokens(tok)} tokens · ${u.calls} calls`;
}
function initUsage() {
  const el = document.getElementById("usageCounter");
  if (el) el.addEventListener("click", () => openSettings("ai"));
  (async () => { try { renderUsageCounter(await (await fetch("/api/usage")).json()); } catch {} })();
}

/* ----------------------- auto-translate chapter ------------------- */
function wireTranslateChapter() {
  const btn = document.getElementById("translateChapterBtn");
  btn?.addEventListener("click", () => doTranslateChapter(chapterSelect.value));
  left.addEventListener("dblclick", (e) => {
    // Double-click a chapter heading → translate the whole chapter.
    const h = e.target.closest(".seg__heading");
    if (h && h.dataset.chapter) { doTranslateChapter(h.dataset.chapter); return; }
    // Double-click an UNTRANSLATED paragraph → translate just that paragraph.
    // (Translated paragraphs keep double-click for the synonym popup.)
    const p = e.target.closest(".seg");
    if (p && p.dataset.id) {
      const seg = targetById.get(p.dataset.id);
      if (seg && (seg.status === "untranslated" || !(seg.targetText || "").trim())) doTranslateSegment(seg, p);
    }
  });
}

async function doTranslateSegment(seg, el) {
  hintEl.textContent = "Translating this paragraph…";
  el.classList.add("is-translating");
  try {
    const out = await translateSegment(seg.id);
    if (out.queued) hintEl.textContent = "Paragraph queued — run /engine in a Claude Code session, or add a free AI key in Settings → AI provider.";
    else hintEl.textContent = `Translating this paragraph with ${out.via}…`;
    // the result lands over SSE as a segment-updated event
  } catch (err) {
    hintEl.textContent = "Translate failed — " + err.message;
  } finally {
    setTimeout(() => el.classList.remove("is-translating"), 4000);
  }
}

let translating = false;
let translateTimer = null;

// Show/clear the "working" state on the Translate button (spinner + pulse + disabled).
function setTranslateWorking(on, labelText) {
  const btn = document.getElementById("translateChapterBtn");
  const lbl = document.getElementById("translateLabel");
  if (!btn) return;
  btn.classList.toggle("is-working", on);
  btn.disabled = on;
  if (lbl) lbl.textContent = on ? (labelText || "Translating…") : "⤳ Translate chapter";
}
function endTranslating() { clearTimeout(translateTimer); translating = false; setTranslateWorking(false); }
function armTranslateTimeout(label) {
  clearTimeout(translateTimer);
  translateTimer = setTimeout(() => {
    translating = false; setTranslateWorking(false);
    hintEl.textContent = `Still waiting on ${label} — run /engine in a Claude Code session in this folder, or add a free AI key in Settings → AI provider.`;
  }, 180000);
}

async function doTranslateChapter(chapterId) {
  if (translating || !chapterId) return; // ignore repeat clicks while one is running
  const label = chapterById.get(chapterId)?.label || chapterId;
  translating = true;
  setTranslateWorking(true, "Translating " + label + "…");
  hintEl.textContent = "Translating " + label + "…";
  try {
    const out = await translateChapter(chapterId);
    if (out.translated === 0 || out.message) {
      hintEl.textContent = out.message || "Nothing to translate here.";
      endTranslating();
    } else if (out.queued) {
      // No external provider — waiting for Claude. Keep the spinner going.
      setTranslateWorking(true, "Translating " + label + "…");
      hintEl.textContent = `${out.count} paragraphs of ${label} queued — run /engine in a Claude Code session in this folder (or /loop 30s /engine to keep it automatic), or add a free AI key in Settings → AI provider.`;
      armTranslateTimeout(label);
    } else {
      setTranslateWorking(true, "Translating " + label + "…");
      hintEl.textContent = `Translating ${out.count} paragraphs of ${label} with ${out.via}…`;
      armTranslateTimeout(label);
    }
  } catch (err) {
    hintEl.textContent = "Translate failed — " + err.message;
    endTranslating();
  }
}

function wireExport() {
  const btn = document.getElementById("exportBtn");
  if (!btn) return;
  const run = async (format) => {
    btn.disabled = true;
    hintEl.textContent = `Exporting ${format === "epub" ? "EPUB" : "Word"}…`;
    try {
      const r = await fetch(`/api/export?book=${encodeURIComponent(currentBook())}&format=${format}`, { method: "POST" });
      const out = await r.json();
      if (!r.ok || out.error) throw new Error(out.error || "Export failed");
      const empties = out.emptyCount ? ` (${out.emptyCount} paragraphs still untranslated)` : "";
      hintEl.textContent = `Exported ${out.bodyCount} paragraphs → ${out.file}${empties}`;
    } catch (err) {
      hintEl.textContent = "Export failed — " + err.message;
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", (e) => {
    // tiny two-choice menu under the button
    document.querySelector(".exportmenu")?.remove();
    const m = document.createElement("div");
    m.className = "exportmenu";
    m.innerHTML = `<button data-f="docx">Word (.docx) — KDP-ready</button><button data-f="epub">EPUB (.epub)</button>`;
    const b = btn.getBoundingClientRect();
    m.style.top = b.bottom + 4 + "px"; m.style.left = Math.min(b.left, innerWidth - 230) + "px";
    m.addEventListener("click", (ev) => { const f = ev.target.dataset?.f; m.remove(); if (f) run(f); });
    document.body.appendChild(m);
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
    e.stopPropagation();
  });
}

/* --------------------------- book tabs ---------------------------- */
async function renderBookTabs() {
  const active = currentBook();
  let books = [];
  try { books = await getBooks(); } catch {}
  bookbar.innerHTML = "";
  for (const b of books) {
    const btn = document.createElement("button");
    btn.className = "bookbar__tab" + (b.id === active ? " is-active" : "");
    btn.textContent = b.label;
    btn.title = `${b.titleTarget || b.titleEn || b.label}${b.ready ? "" : " — not imported yet"}`;
    if (b.id !== active) btn.addEventListener("click", () => { location.search = "?book=" + encodeURIComponent(b.id); });
    bookbar.appendChild(btn);
  }
  // "+" tab: the library — overview of all books + import a new one.
  const add = document.createElement("button");
  add.className = "bookbar__tab bookbar__add";
  add.textContent = "+";
  add.title = "Your books — overview & add a new book";
  add.addEventListener("click", openLibrary);
  bookbar.appendChild(add);
}

/* ----------------------------- render ----------------------------- */
function renderChapterSelect() {
  chapterSelect.innerHTML = "";
  for (const c of project.chapters) {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.label;
    chapterSelect.appendChild(o);
  }
  chapterSelect.addEventListener("change", () => scrollToChapter(chapterSelect.value));
}

function renderPane(paneEl, segments, side) {
  const frag = document.createDocumentFragment();
  for (const s of segments) {
    const kind = side === "source" ? sourceKind(s) : s.kind;
    let el;
    if (kind === "heading") {
      el = document.createElement("h2");
      el.className = "seg__heading";
      el.textContent = displayText(s, side);
    } else if (kind === "label") {
      el = document.createElement("p");
      el.className = "seg__label";
      el.textContent = displayText(s, side);
    } else {
      el = document.createElement("p");
      el.className = "seg" + (kind === "blockquote" ? " seg--blockquote" : "");
      el.textContent = displayText(s, side);
      if (side === "target") {
        el.dataset.status = s.status;
        el.setAttribute("contenteditable", "true");
        el.spellcheck = false;
        if (!(s.targetText || "").trim()) el.dataset.ph = "Translate…";
        wireEditable(el, s);
      } else {
        el.dataset.status = "source";
      }
    }
    el.dataset.id = s.id;
    el.dataset.chapter = s.chapterId;
    frag.appendChild(el);
  }
  paneEl.appendChild(frag);
}

function sourceKind(s) {
  if (s.style === "heading") return "heading";
  if (s.style === "label") return "label";
  return "body";
}
function displayText(s, side) {
  return side === "source" ? s.text : (s.targetText ?? s.raw ?? "");
}

// Cache element lists + id→element maps, and index within-chapter positions.
function cacheSegEls() {
  for (const side of ["left", "right"]) {
    const pane = side === "left" ? left : right;
    segEls[side] = [...pane.querySelectorAll("[data-id]")];
    elById[side].clear();
    chTotals[side] = {};
    for (const el of segEls[side]) {
      elById[side].set(el.dataset.id, el);
      if (el.classList.contains("seg")) {
        const c = el.dataset.chapter;
        chTotals[side][c] = (chTotals[side][c] || 0) + 1;
        el.dataset.chidx = chTotals[side][c];
      }
    }
  }
}

/* --------------------------- selection ---------------------------- */
function wireSelection() {
  left.addEventListener("mouseenter", () => (activePane = "left"));
  right.addEventListener("mouseenter", () => (activePane = "right"));
  left.addEventListener("mouseup", () => onSelect("left"));
  right.addEventListener("mouseup", () => onSelect("right"));
  left.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow")) onSelect("left"); });

  // Right-click or double-click a translated word → synonym popup.
  left.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".seg[contenteditable]");
    if (!el) return;
    e.preventDefault();
    synonymsFromPoint(el, e.clientX, e.clientY);
  });
  left.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".seg[contenteditable]");
    if (el) synonymsFromSelection(el);
  });
}

// Save a word replacement made from the synonym popup.
async function saveReplacement(segId, newText, el, meta) {
  try {
    const updated = await patchSegment(segId, newText, meta);
    const seg = targetById.get(segId);
    if (seg) { seg.targetText = updated.targetText; seg.status = updated.status; }
    if (el) el.dataset.status = updated.status;
    hintEl.textContent = "Saved.";
  } catch (err) {
    hintEl.textContent = "Couldn't save — " + err.message;
  }
}

function onSelect(side) {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return;
  const segEl = closestSeg(sel.anchorNode);
  if (!segEl) return;
  stitch(segEl.dataset.id, side);

  // Drive the inspector with the active TARGET paragraph.
  let targetSeg = null;
  if (side === "left") {
    targetSeg = targetById.get(segEl.dataset.id);
  } else {
    const src = sourceById.get(segEl.dataset.id);
    const tid = (src?.targetLinks || [])[0];
    targetSeg = tid ? targetById.get(tid) : null;
  }
  inspectorSetActive(targetSeg, side === "left" ? sel.toString() : "");

  // Chat auto-activates on click/select. Focus the chat box only when the user
  // isn't placing a caret to edit a target paragraph (source click, or a real
  // text selection) — so inline editing keeps keyboard focus. A single-word
  // selection in the translation is left to the synonym popup instead.
  const selText = sel.toString().trim();
  const hasRange = !sel.isCollapsed;
  const singleWord = selText && !/\s/.test(selText);
  if (!(side === "left" && singleWord)) activateChat(side === "right" || hasRange);

  updatePosition();
}

function closestSeg(node) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && !(el.dataset && el.dataset.id)) el = el.parentElement;
  return el && el.classList.contains("seg") ? el : null;
}

// Light the selected paragraph and its counterpart(s) across the seam.
function stitch(segId, side) {
  clearStitch();
  const [fromMap, toMap, toPane] = side === "left"
    ? [elById.left, elById.right, right]
    : [elById.right, elById.left, left];
  const fromSeg = side === "left" ? targetById.get(segId) : sourceById.get(segId);
  if (!fromSeg) return;

  fromMap.get(segId)?.classList.add("is-active");

  const links = side === "left" ? (fromSeg.sourceLinks || []) : (fromSeg.targetLinks || []);
  let firstEl = null;
  for (const id of links) {
    const el = toMap.get(id);
    if (el) { el.classList.add("is-linked"); if (!firstEl) firstEl = el; }
  }
  if (firstEl) {
    firstEl.scrollIntoView({ block: "center", behavior: "smooth" });
    placeKnot(firstEl, toPane);
  }
}

function clearStitch() {
  document.querySelectorAll(".is-active, .is-linked").forEach((e) => e.classList.remove("is-active", "is-linked"));
}

function placeKnot(el, paneEl) {
  let knot = seam.querySelector(".seam__knot");
  if (!knot) { knot = document.createElement("div"); knot.className = "seam__knot"; seam.appendChild(knot); }
  const paneRect = paneEl.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const seamRect = seam.getBoundingClientRect();
  const y = Math.min(Math.max(elRect.top + elRect.height / 2, paneRect.top), paneRect.bottom) - seamRect.top;
  knot.style.top = y + "px";
  knot.classList.add("is-on");
}

/* -------------------------- scroll sync --------------------------- */
function wireScrollSync() {
  let syncing = false;
  const sync = (fromKey, toKey, mapId) => {
    if (syncing) return;
    const fromPane = fromKey === "left" ? left : right;
    const toPane = toKey === "left" ? left : right;
    const seg = topmostSeg(fromKey);
    if (!seg) return;
    const linkedId = mapId(seg.dataset.id);
    if (!linkedId) return;
    const target = elById[toKey].get(linkedId);
    if (!target) return;
    syncing = true;
    const offset = seg.offsetTop - fromPane.scrollTop;
    toPane.scrollTop = target.offsetTop - offset;
    requestAnimationFrame(() => { syncing = false; });
    repositionKnot();
  };
  left.addEventListener("scroll", () => { if (activePane === "left") sync("left", "right", (id) => (targetById.get(id)?.sourceLinks || [])[0]); updatePosition(); });
  right.addEventListener("scroll", () => { if (activePane === "right") sync("right", "left", (id) => (sourceById.get(id)?.targetLinks || [])[0]); updatePosition(); });
}

// Binary search: topmost segment whose offsetTop is at/above the viewport top.
function topmostSeg(paneKey) {
  const arr = segEls[paneKey];
  if (!arr.length) return null;
  const pane = paneKey === "left" ? left : right;
  const target = pane.scrollTop + 44;
  let lo = 0, hi = arr.length - 1, best = arr[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].offsetTop <= target) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function repositionKnot() {
  const linked = document.querySelector(".leaf--source .is-linked") || document.querySelector(".leaf--target .is-linked");
  const knot = seam.querySelector(".seam__knot.is-on");
  if (linked && knot) placeKnot(linked, linked.closest(".pane"));
}

/* --------------------------- position ----------------------------- */
function updatePosition() {
  const seg = topmostSeg(activePane);
  if (!seg) return;
  const chId = seg.dataset.chapter;
  const ch = chapterById.get(chId);
  const total = chTotals[activePane][chId] || 1;
  const n = seg.dataset.chidx ? +seg.dataset.chidx : 1;
  positionEl.innerHTML = `<b>${ch ? esc(ch.label) : ""}</b> &middot; &para; ${n} / ${total}`;
  if (chapterSelect.value !== chId) chapterSelect.value = chId;
}

function scrollToChapter(chId) {
  const el = elById.left.get(chapterFirstSegId(chId));
  if (el) { activePane = "left"; el.scrollIntoView({ block: "start", behavior: "smooth" }); }
}
function chapterFirstSegId(chId) {
  const first = segEls.left.find((e) => e.dataset.chapter === chId);
  return first ? first.dataset.id : null;
}

/* --------------------------- editing ------------------------------ */
function wireEditable(el, seg) {
  let original = el.textContent;
  el.addEventListener("focus", () => { original = el.textContent; activePane = "left"; });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); el.textContent = original; el.blur(); }
  });
  el.addEventListener("blur", async () => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    const before = original.replace(/\s+/g, " ").trim();
    if (text === before) { el.textContent = original; return; }
    try {
      const updated = await patchSegment(seg.id, text);
      seg.targetText = updated.targetText;
      seg.status = updated.status;
      el.dataset.status = updated.status;
      el.textContent = updated.targetText;
      if (updated.targetText.trim()) delete el.dataset.ph; else el.dataset.ph = "Translate…";
      original = updated.targetText;
      hintEl.textContent = "Saved.";
    } catch (err) {
      el.textContent = original;
      hintEl.textContent = "Couldn't save that edit — " + err.message;
    }
  });
}

/* --------------------------- live (SSE) --------------------------- */
function applySegmentUpdate(data) {
  const seg = targetById.get(data.id);
  if (!seg) return data;
  if (data.targetText != null) seg.targetText = data.targetText;
  if (data.status) seg.status = data.status;
  if (data.hesitations) seg.hesitations = data.hesitations;
  if ("claudeSuggestions" in data) seg.claudeSuggestions = data.claudeSuggestions;
  const el = elById.left.get(data.id);
  if (el) {
    if (data.targetText != null && document.activeElement !== el) {
      el.textContent = seg.targetText;
      if (seg.targetText.trim()) delete el.dataset.ph;
    }
    if (seg.status) el.dataset.status = seg.status;
  }
  updateProgress();
  return seg;
}

function connectEvents() {
  try {
    const es = new EventSource("/api/events?book=" + encodeURIComponent(currentBook()));
    es.addEventListener("segment-updated", (e) => {
      const d = JSON.parse(e.data);
      applySegmentUpdate(d);
      onServerEvent("segment-updated", d);
    });
    es.addEventListener("chat-message", (e) => onServerEvent("chat-message", JSON.parse(e.data)));
    es.addEventListener("synonyms", (e) => onSynonymsEvent(JSON.parse(e.data)));
    es.addEventListener("usage", (e) => renderUsageCounter(JSON.parse(e.data)));
    es.addEventListener("chapter-translated", (e) => {
      const d = JSON.parse(e.data);
      endTranslating();
      const label = chapterById.get(d.chapterId)?.label || d.chapterId;
      hintEl.textContent = d.error ? `Translate failed — ${d.error}`
        : `Translated ${d.filled} paragraph${d.filled === 1 ? "" : "s"} of ${label}${d.via ? " (" + d.via + ")" : ""} — review the blue ones.`;
    });
  } catch (e) { /* SSE optional */ }
}

function esc(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
