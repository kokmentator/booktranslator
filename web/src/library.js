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
      return `<div class="libcard${b.id === active ? " is-active" : ""}${b.ready ? "" : " is-disabled"}" data-book="${esc(b.id)}" role="button" tabindex="0">
        <div class="libcard__actions">
          <button type="button" class="libcard__act" data-ren="${esc(b.id)}" title="Rename">✎</button>
          <button type="button" class="libcard__act" data-del="${esc(b.id)}" title="Delete (moves to data/_trash — nothing is lost)">×</button>
        </div>
        <div class="libcard__title">${esc(b.titleTarget || b.label)}</div>
        ${b.titleSource ? `<div class="libcard__src">${esc(b.titleSource)}</div>` : ""}
        <div class="libcard__meta">${esc(b.author || "")}${b.author && langs ? " · " : ""}${langs}</div>
        ${bar}
      </div>`;
    }).join("");
    list.querySelectorAll(".libcard[data-book]").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest(".libcard__act")) return;
        if (el.classList.contains("is-disabled")) return;
        location.search = "?book=" + encodeURIComponent(el.dataset.book);
      }));
    list.querySelectorAll("[data-ren]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.ren;
      const book = books.find((x) => x.id === id);
      const title = prompt("New title (target language):", book?.titleTarget || book?.label || "");
      if (title === null || !title.trim()) return;
      try {
        const r = await (await fetch(`/api/book/rename?book=${encodeURIComponent(id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), label: title.trim() }),
        })).json();
        if (r.error) throw new Error(r.error);
        renderList();
        if (id === currentBook()) location.reload();
      } catch (e) { status.textContent = "Rename failed — " + e.message; }
    }));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.del;
      if (!confirm(`Remove "${id}" from the shelf?\n\nIts folder moves to data/_trash — nothing is deleted permanently.`)) return;
      try {
        const r = await (await fetch(`/api/book/delete?book=${encodeURIComponent(id)}`, { method: "POST" })).json();
        if (r.error) throw new Error(r.error);
        if (id === currentBook()) { location.search = ""; return; }
        renderList();
      } catch (e) { status.textContent = "Delete failed — " + e.message; }
    }));
  }

  // Two-step import: first a dry-run preview of the detected chapters, then confirm.
  let previewedFor = "";
  const fileKey = (f) => f.name + ":" + f.size;
  $("impFile")?.addEventListener("change", () => {
    previewedFor = ""; $("impGo").textContent = "Preview import";
    document.getElementById("impPreview")?.remove();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("impFile").files[0];
    if (!file) { status.textContent = "Pick a manuscript file first."; return; }
    if (file.size > 50 * 1024 * 1024) { status.textContent = "File too large (max 50 MB)."; return; }
    $("impGo").disabled = true;
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(new Error("could not read the file"));
        r.readAsDataURL(file);
      });
      const payload = {
        fileName: file.name, dataBase64,
        title: $("impTitle").value.trim(),
        titleSource: $("impTitleSource").value.trim(),
        author: $("impAuthor").value.trim(),
        sourceLang: $("impSourceLang").value.trim(),
        targetLang: $("impTargetLang").value.trim(),
      };

      if (previewedFor !== fileKey(file)) {
        // STEP 1 — preview: parse + chapter detection, nothing written yet.
        status.textContent = "Reading the manuscript…";
        const res = await fetch("/api/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, dryRun: true }),
        });
        const out = await res.json();
        if (!res.ok || out.error) throw new Error(out.error || res.statusText);
        document.getElementById("impPreview")?.remove();
        const div = document.createElement("div");
        div.id = "impPreview";
        div.className = "imp-preview";
        div.innerHTML = `<b>${out.chapters} chapter${out.chapters === 1 ? "" : "s"} detected · ${out.paragraphs} paragraphs</b>
          <ul>${out.chapterList.map((c) => `<li><b>${esc(c.label)}</b> — ${c.paragraphs} ¶${c.firstLine ? ` <span class="imp-preview__line">“${esc(c.firstLine)}…”</span>` : ""}</li>`).join("")}</ul>
          <div class="settings__note" style="margin:0">Chapter split looks wrong? Add clear headings ("Chapter 1", "# Title", ALL CAPS lines) to the manuscript and pick the file again.</div>`;
        form.insertBefore(div, form.querySelector(".settings__actions"));
        previewedFor = fileKey(file);
        $("impGo").textContent = "Looks right — import";
        status.textContent = "Check the chapter split, then confirm.";
        $("impGo").disabled = false;
        return;
      }

      // STEP 2 — confirmed: real import.
      status.textContent = "Importing…";
      const res = await fetch("/api/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
