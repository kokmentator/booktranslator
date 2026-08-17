// Settings modal: Guide, AI provider (+ token usage), and translation Style sliders.
// Style is PER BOOK — the sliders read/save the book currently open on the desk.
// Anything off falls back to the built-in Claude session path.
import { currentBook } from "./api.js";

const $ = (id) => document.getElementById(id);
const bookQ = () => "?book=" + encodeURIComponent(currentBook());

let _show = null;
// Open the Settings modal on a given tab ("guide" | "ai" | "style") from elsewhere.
export function openSettings(tab) { if (_show) _show(tab); }

export function initSettings() {
  const btn = $("settingsBtn"), modal = $("settings"), backdrop = $("settingsBackdrop"), close = $("settingsClose");
  if (!btn || !modal) return;
  const provider = $("setProvider"), key = $("setKey"), model = $("setModel"), baseUrl = $("setBaseUrl");
  const syn = $("setSyn"), chat = $("setChat"), save = $("setSave"), status = $("setStatus");
  let presets = {};

  async function load() {
    let c = {};
    try { c = await (await fetch("/api/engine/config")).json(); } catch {}
    presets = c.presets || {};
    provider.innerHTML = Object.entries(presets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
    provider.value = c.provider || "claude";
    model.value = c.model || "";
    baseUrl.value = c.baseUrl || "";
    syncPlaceholders();
    key.value = "";
    key.placeholder = c.hasKey ? "key saved — leave blank to keep" : "paste API key";
    syn.checked = !!c.synonymsEnabled;
    chat.checked = !!c.chatEnabled;
    status.textContent = "";
    loadUsage();
  }
  function syncPlaceholders() {
    const p = presets[provider.value] || {};
    model.placeholder = p.model || "preset default";
    baseUrl.placeholder = p.baseUrl || "preset default";
  }
  provider.addEventListener("change", syncPlaceholders);

  save.addEventListener("click", async () => {
    status.textContent = "Saving…";
    const body = {
      provider: provider.value, model: model.value.trim(), baseUrl: baseUrl.value.trim(),
      synonymsEnabled: syn.checked, chatEnabled: chat.checked,
    };
    if (key.value.trim()) body.apiKey = key.value.trim();
    try {
      const c = await (await fetch("/api/engine/config", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      status.textContent = "Saved.";
      key.value = "";
      key.placeholder = c.hasKey ? "key saved — leave blank to keep" : "paste API key";
    } catch (e) { status.textContent = "Save failed."; }
  });

  // Token usage breakdown
  const usageReset = $("usageReset"), usageResetStatus = $("usageResetStatus");
  usageReset?.addEventListener("click", async () => {
    if (!confirm("Reset the token counter to zero?")) return;
    usageResetStatus.textContent = "Resetting…";
    try {
      renderUsagePanel(await (await fetch("/api/usage/reset", { method: "POST" })).json());
      const foot = $("usageCounter"); if (foot) foot.hidden = true;
      usageResetStatus.textContent = "Reset.";
    } catch { usageResetStatus.textContent = "Failed."; }
  });

  // Guide / AI provider / Style tabs
  document.querySelectorAll(".settings-tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.stab)));
  function switchTab(which) {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.stab === which));
    document.querySelectorAll(".stabpane").forEach((p) => p.classList.toggle("is-active", p.id === "stab-" + which));
  }

  initStyleSliders();

  const show = async (tab) => { await load(); switchTab(tab || "guide"); modal.hidden = false; backdrop.hidden = false; };
  _show = show;
  const hide = () => { modal.hidden = true; backdrop.hidden = true; };
  btn.addEventListener("click", () => show("guide"));
  close.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) hide(); });
}

/* ---------------- Translation style sliders ---------------- */
function initStyleSliders() {
  const wrap = $("styleSliders"), save = $("styleSave"), defaultsBtn = $("styleDefaults"), status = $("styleStatus");
  if (!wrap) return;
  let meta = {};

  function row(key, m, value) {
    return `<div class="style-slider" data-key="${esc(key)}">
      <div class="style-slider__head"><span class="style-slider__label">${esc(m.label)}</span><span class="style-slider__val">${value}</span></div>
      <input type="range" min="0" max="100" step="5" value="${value}">
      <div class="style-slider__ends"><span>${esc(m.low)}</span><span>${esc(m.high)}</span></div>
    </div>`;
  }
  function render(values) {
    wrap.innerHTML = Object.entries(meta).map(([k, m]) => row(k, m, values[k] ?? m.def)).join("");
    wrap.querySelectorAll(".style-slider input").forEach((inp) =>
      inp.addEventListener("input", () => { inp.closest(".style-slider").querySelector(".style-slider__val").textContent = inp.value; }));
  }
  function currentValues() {
    const out = {};
    wrap.querySelectorAll(".style-slider").forEach((d) => { out[d.dataset.key] = Number(d.querySelector("input").value); });
    return out;
  }

  (async () => {
    try {
      const d = await (await fetch("/api/style" + bookQ())).json();
      meta = d.sliders || {};
      render(d.values || {});
    } catch { wrap.textContent = "Style settings unavailable."; }
  })();

  save?.addEventListener("click", async () => {
    status.textContent = "Saving…";
    try {
      const d = await (await fetch("/api/style" + bookQ(), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(currentValues()),
      })).json();
      render(d.values || {});
      status.textContent = "Saved for this book — applies from the next AI request.";
    } catch { status.textContent = "Save failed."; }
  });
  defaultsBtn?.addEventListener("click", () => {
    render(Object.fromEntries(Object.entries(meta).map(([k, m]) => [k, m.def])));
    status.textContent = "Defaults restored — press Save to apply.";
  });
}

/* ---------------- Token usage panel ---------------- */
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
async function loadUsage() {
  const panel = $("usagePanel");
  if (!panel) return;
  try { renderUsagePanel(await (await fetch("/api/usage")).json()); }
  catch { panel.textContent = "Usage unavailable."; }
}
function renderUsagePanel(u) {
  const panel = $("usagePanel");
  if (!panel) return;
  if (!u || !u.calls) { panel.textContent = "No AI calls yet."; return; }
  const rows = Object.entries(u.byProvider || {}).map(([name, p]) =>
    `<tr><td>${esc(name)}</td><td>${p.calls}</td><td>${fmtTokens((p.inputTokens || 0) + (p.outputTokens || 0))}</td></tr>`).join("");
  const since = u.firstTs ? new Date(u.firstTs).toLocaleString() : "—";
  panel.innerHTML =
    `<table class="usage__table">
      <thead><tr><th>Provider</th><th>Calls</th><th>Tokens</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td><b>Total</b></td><td><b>${u.calls}</b></td><td><b>${fmtTokens((u.inputTokens || 0) + (u.outputTokens || 0))}</b></td></tr></tfoot>
    </table>
    <div class="usage__meta">${(u.inputTokens || 0).toLocaleString()} in · ${(u.outputTokens || 0).toLocaleString()} out · since ${esc(since)}</div>`;
}

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
