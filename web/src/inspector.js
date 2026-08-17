// The right-hand inspector: Suggestions (resolve parsed hesitations) and Chat
// (discuss with Claude, apply to selection). Talks to the server over the API;
// main.js feeds it the active segment and forwards live SSE events.
import { decideSegment, patchSegment, getChat, postChat } from "./api.js";

let applyToEditor = () => {};   // main.js hook to update the editor pane
let chapterLabel = () => "";
let activeSeg = null;
let activeSelectedText = "";
let pendingEl = null;
let pendingTimer = null;

const $ = (id) => document.getElementById(id);

export function initInspector(hooks) {
  applyToEditor = hooks.applyToEditor || applyToEditor;
  chapterLabel = hooks.chapterLabel || chapterLabel;

  document.querySelectorAll(".inspector__tab").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, true)));
  $("panelToggle").addEventListener("click", () => document.body.classList.toggle("panel-collapsed"));

  const form = $("chatForm");
  form.addEventListener("submit", onChatSubmit);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  $("tab-suggestions").addEventListener("click", onSuggestionClick);
  $("chatThread").addEventListener("click", onThreadClick);

  renderSuggestions(null);
  loadChat();
}

function switchTab(tab, focus = false) {
  document.querySelectorAll(".inspector__tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  $("tab-suggestions").classList.toggle("is-active", tab === "suggestions");
  $("tab-chat").classList.toggle("is-active", tab === "chat");
  if (tab === "chat" && focus) $("chatInput").focus();
}

// Called when a paragraph is clicked/selected — bring the Chat tab up.
// Focus the input only when the caller says so (so inline editing isn't disturbed).
export function activateChat(focus) {
  switchTab("chat", focus && !document.body.classList.contains("panel-collapsed"));
}

/* ---- called by main.js when the active paragraph changes ---- */
export function setActive(seg, selectedText) {
  activeSeg = seg && (seg.kind === "body" || seg.kind === "blockquote") ? seg : null;
  activeSelectedText = selectedText || "";
  renderSuggestions(activeSeg);
  setChatContext(activeSeg, activeSelectedText);
}

/* ---- forwarded SSE events ---- */
export function onServerEvent(type, data) {
  if (type === "segment-updated") {
    if (activeSeg && data.id === activeSeg.id) {
      Object.assign(activeSeg, pick(data, ["status", "targetText", "hesitations", "claudeSuggestions"]));
      renderSuggestions(activeSeg);
    }
  } else if (type === "chat-message") {
    clearPending();
    appendTurn(data);
  }
}
function pick(o, keys) { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; }

/* ----------------------------- suggestions ----------------------------- */
function renderSuggestions(seg) {
  const box = $("tab-suggestions");
  if (!seg) {
    box.innerHTML = `<div class="empty">Select a paragraph on the left to see its <b>suggestions</b>.<br>Paragraphs with an <b>ochre mark</b> have open choices.</div>`;
    return;
  }
  const hes = seg.hesitations || [];
  const claude = seg.claudeSuggestions;
  const parts = [];

  hes.forEach((h, i) => {
    if (h.kind === "note" || h.kind === "clarify") parts.push(noteCard(h, i));
    else parts.push(altCard(h, i, seg.targetText));
  });
  if (claude && (claude.options || []).length) parts.push(claudeCard(claude));

  if (!parts.length) {
    box.innerHTML = `<div class="empty">No open suggestions here.<br>This paragraph reads as <b>settled</b>.</div>`;
  } else {
    box.innerHTML = parts.join("");
  }
}

function altCard(h, i, text) {
  if (h.resolved) {
    return `<div class="card"><div class="card__resolved">&#10003; kept <b>&nbsp;${esc(h.chosen)}</b></div>
      ${h.options?.length ? `<div class="card__opts">${optButtons(h, i)}</div>` : ""}</div>`;
  }
  return `<div class="card">
    <div class="card__phrase">${snippet(text, h.span)}</div>
    ${h.options?.length ? `<div class="card__opts">${optButtons(h, i)}
      <button class="opt opt--keep" data-act="keep" data-h="${i}">Keep “${esc(h.span)}”</button></div>` : ""}
    ${h.reasoning ? `<div class="card__why">${esc(h.reasoning)}</div>` : ""}
  </div>`;
}
function optButtons(h, i) {
  return (h.options || []).map((o, j) => `<button class="opt" data-act="choose" data-h="${i}" data-o="${j}">${esc(o)}</button>`).join("");
}
function noteCard(h, i) {
  return `<div class="card card--note">
    <div class="card__label">${h.kind === "note" ? "Decision needed" : "Translator note"}</div>
    <div class="card__phrase"><span class="word">${esc(h.span)}</span></div>
    <div class="card__why">${esc(h.note || "")}</div>
    <div class="card__actions"><button class="btn-mini" data-act="keep" data-h="${i}">Mark handled</button></div>
  </div>`;
}
function claudeCard(c) {
  const opts = (c.options || []).map((o, j) =>
    `<div class="card__phrase">${esc(o.text || o)}</div>
     ${o.rationale ? `<div class="card__why">${esc(o.rationale)}</div>` : ""}
     <div class="card__actions"><button class="btn-mini" data-act="claude" data-o="${j}">Apply this</button></div>`).join("<hr style='border:0;border-top:1px solid #eee;margin:.6rem 0'>");
  return `<div class="card card--claude">
    <div class="card__label">Claude’s suggestion</div>
    ${c.note ? `<div class="card__why">${esc(c.note)}</div>` : ""}
    ${opts}
    <div class="card__actions"><button class="btn-mini" data-act="dismissClaude">Dismiss</button></div>
  </div>`;
}

// show the uncertain span inside a little slice of its sentence
function snippet(text, span) {
  const i = text.indexOf(span);
  if (i < 0) return `<span class="word">${esc(span)}</span>`;
  const a = Math.max(0, i - 32), b = Math.min(text.length, i + span.length + 32);
  return `${a > 0 ? "…" : ""}${esc(text.slice(a, i))}<span class="word">${esc(span)}</span>${esc(text.slice(i + span.length, b))}${b < text.length ? "…" : ""}`;
}

async function onSuggestionClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !activeSeg) return;
  const act = btn.dataset.act;
  const body =
    act === "choose" ? { action: "choose", hesitationIndex: +btn.dataset.h, optionIndex: +btn.dataset.o } :
    act === "keep" ? { action: "keep", hesitationIndex: +btn.dataset.h } :
    act === "claude" ? { action: "chooseClaude", optionIndex: +btn.dataset.o } :
    act === "dismissClaude" ? { action: "dismissClaude" } : null;
  if (!body) return;
  try {
    const seg = await decideSegment(activeSeg.id, body);
    activeSeg = seg;
    applyToEditor(seg);
    renderSuggestions(seg);
  } catch (err) { flash("Couldn’t apply that — " + err.message); }
}

/* -------------------------------- chat -------------------------------- */
function setChatContext(seg, selectedText) {
  const ctx = $("chatContext");
  if (!seg) { ctx.hidden = true; return; }
  const text = (selectedText && selectedText.trim()) || seg.targetText;
  ctx.hidden = false;
  ctx.innerHTML = `<span class="ctx-label">Discussing</span> ${esc(chapterLabel(seg.chapterId))}<br><span class="ctx-text">“${esc(clip(text, 120))}”</span>`;
}

async function loadChat() {
  const turns = await getChat();
  $("chatThread").innerHTML = "";
  turns.forEach(appendTurn);
}

function appendTurn(turn) {
  const thread = $("chatThread");
  const el = document.createElement("div");
  el.className = "msg msg--" + (turn.role === "editor" ? "editor" : "claude");
  el.textContent = turn.text;
  if (turn.role === "claude" && turn.proposedText && turn.segmentId) {
    const wrap = document.createElement("div");
    wrap.className = "msg__apply";
    const b = document.createElement("button");
    b.className = "btn-mini";
    b.textContent = "Apply to selection";
    b.dataset.apply = turn.segmentId;
    b.dataset.text = turn.proposedText;
    wrap.appendChild(b);
    el.appendChild(wrap);
  }
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

async function onChatSubmit(e) {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const payload = { text, segmentId: activeSeg?.id || null, selectedText: activeSelectedText || null };
  try {
    const turn = await postChat(payload);
    appendTurn(turn);
    showPending();
  } catch (err) { flash("Message failed — " + err.message); }
}

async function onThreadClick(e) {
  const b = e.target.closest("[data-apply]");
  if (!b) return;
  try {
    const seg = await patchSegment(b.dataset.apply, b.dataset.text);
    applyToEditor(seg);
    b.textContent = "Applied ✓";
    b.disabled = true;
  } catch (err) { flash("Couldn’t apply — " + err.message); }
}

function showPending() {
  clearPending();
  pendingEl = document.createElement("div");
  pendingEl.className = "msg msg--pending";
  pendingEl.textContent = "Claude is reading the passage…";
  $("chatThread").appendChild(pendingEl);
  $("chatThread").scrollTop = $("chatThread").scrollHeight;
  // If nothing answers, explain why instead of hanging forever.
  pendingTimer = setTimeout(() => {
    if (pendingEl) pendingEl.textContent = "Waiting for an AI engine… Ask Claude in a session to answer, or connect a free provider in Settings → AI provider for instant replies.";
  }, 25000);
}
function clearPending() { clearTimeout(pendingTimer); if (pendingEl) { pendingEl.remove(); pendingEl = null; } }

/* ------------------------------- helpers ------------------------------ */
export function focusChat() { switchTab("chat", true); }
function flash(m) { const h = $("hint"); if (h) h.textContent = m; }
function clip(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
