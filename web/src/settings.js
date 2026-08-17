// AI settings modal: pick a provider + key, toggle it on for Synonyms / Chat.
// Anything off falls back to the built-in Claude session path.
const $ = (id) => document.getElementById(id);

let _show = null;
// Open the Settings modal on a given tab ("guide" | "ai") from elsewhere.
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

  // Guide / AI provider tabs
  document.querySelectorAll(".settings-tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.stab)));
  function switchTab(which) {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.stab === which));
    document.getElementById("stab-guide").classList.toggle("is-active", which === "guide");
    document.getElementById("stab-ai").classList.toggle("is-active", which === "ai");
  }

  const show = async (tab) => { await load(); switchTab(tab || "guide"); modal.hidden = false; backdrop.hidden = false; };
  _show = show;
  const hide = () => { modal.hidden = true; backdrop.hidden = true; };
  btn.addEventListener("click", () => show("guide"));
  close.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) hide(); });
}

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
