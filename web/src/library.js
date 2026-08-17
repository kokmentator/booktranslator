// Library: overview of all books (progress, language pair) + the Add-a-book form.
import { getBooks, currentBook } from "./api.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let _show = null;
export function openLibrary() { if (_show) _show(); }

export function initLibrary() {
  const modal = $("library"), backdrop = $("libraryBackdrop"), close = $("libraryClose");
  const list = $("libraryList"), form = $("importForm"), status = $("impStatus");
  if (!modal) return;

  async function renderList() {
    let books = [];
    try { books = await getBooks(); } catch {}
    const active = currentBook();
    list.innerHTML = books.map((b) => {
      const langs = b.languages ? `${esc(b.languages.source?.name)} → ${esc(b.languages.target?.name)}` : "";
      const p = b.progress;
      const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
      const bar = p ? `<div class="libcard__bar"><i style="width:${pct}%"></i></div>
        <div class="libcard__stats">${p.done} / ${p.total} paragraphs · ${p.chapters} chapters · ${pct}%</div>`
        : `<div class="libcard__stats">not imported yet</div>`;
      return `<button class="libcard${b.id === active ? " is-active" : ""}" data-book="${esc(b.id)}" ${b.ready ? "" : "disabled"}>
        <div class="libcard__title">${esc(b.titleTarget || b.label)}</div>
        ${b.titleSource ? `<div class="libcard__src">${esc(b.titleSource)}</div>` : ""}
        <div class="libcard__meta">${esc(b.author || "")}${b.author && langs ? " · " : ""}${langs}</div>
        ${bar}
      </button>`;
    }).join("");
    list.querySelectorAll(".libcard[data-book]").forEach((el) =>
      el.addEventListener("click", () => { location.search = "?book=" + encodeURIComponent(el.dataset.book); }));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("impFile").files[0];
    if (!file) { status.textContent = "Pick a manuscript file first."; return; }
    if (file.size > 50 * 1024 * 1024) { status.textContent = "File too large (max 50 MB)."; return; }
    status.textContent = "Importing…";
    $("impGo").disabled = true;
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(new Error("could not read the file"));
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name, dataBase64,
          title: $("impTitle").value.trim(),
          titleSource: $("impTitleSource").value.trim(),
          author: $("impAuthor").value.trim(),
          sourceLang: $("impSourceLang").value.trim(),
          targetLang: $("impTargetLang").value.trim(),
        }),
      });
      const out = await res.json();
      if (!res.ok || out.error) throw new Error(out.error || res.statusText);
      status.textContent = `Imported — ${out.paragraphs} paragraphs, ${out.chapters} chapters. Opening…`;
      location.search = "?book=" + encodeURIComponent(out.bookId);
    } catch (err) {
      status.textContent = "Import failed — " + err.message;
      $("impGo").disabled = false;
    }
  });

  const show = async () => { await renderList(); status.textContent = ""; $("impGo").disabled = false; modal.hidden = false; backdrop.hidden = false; };
  _show = show;
  const hide = () => { modal.hidden = true; backdrop.hidden = true; };
  close.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) hide(); });
}
