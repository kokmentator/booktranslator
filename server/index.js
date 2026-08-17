// BookTranslator local server: serves the frontend and the per-book project API.
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject, dataDir } from "./store.js";
import { sseHandler, broadcast } from "./events.js";
import { startWatcher, writeRequest } from "./watch.js";
import { appendChat, readChat } from "./chat.js";
import { decide } from "./decide.js";
import { loadBooks, isValidBook, bookById, defaultBookId } from "./registry.js";
import { languagesFor, styleFiles } from "./config.js";
import { exportDocx } from "./export/exportDocx.js";
import { exportEpub } from "./export/exportEpub.js";
import { getSynonyms } from "./synonyms.js";
import { parseTables, reloadTermbase } from "./termbase.js";
import { resolveFeature, publicConfig, saveConfig, providerSettings } from "./engineConfig.js";
import { llmSynonyms, llmChat } from "./llm.js";
import { translateItems } from "./translate.js";
import { buildRulesDigest, rulesVersion, clearRulesCache } from "./translationContext.js";
import { importManuscript, slugFromTitle } from "./import/importCore.js";
import { getUsage, resetUsage } from "./usage.js";
import { loadStyle, saveStyle, STYLE_SLIDERS } from "./styleConfig.js";
import { appendEvent } from "./training/events.js";
import { exportDataset, datasetStats } from "./training/exportDataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(PROJECT_ROOT, "web");
const PORT = process.env.PORT || 4319;
// Bind to loopback by default: this is a single-user desktop app holding an API
// key and book manuscripts — it must not be reachable by the rest of the LAN
// (café wifi, office network). Set HOST=0.0.0.0 explicitly if you really want that.
const HOST = process.env.HOST || "127.0.0.1";

// Resolve the active book from ?book=, validated against the registry.
const bookOf = (req) => {
  const b = (req.query.book || defaultBookId()).toString();
  return isValidBook(b) ? b : defaultBookId();
};
const hasProject = (id) => fs.existsSync(path.join(dataDir(id), "project.json"));

const app = express();
app.use(express.json({ limit: "4mb" }));

// Exchange watchers per book — kept so deleting a book can close its watcher
// first (Windows refuses to move a directory something still has open).
const watchers = new Map();
const watchBook = (id) => { if (!watchers.has(id)) watchers.set(id, startWatcher(id)); };

// --- Registry (with per-book translation progress for the library view) ---
app.get("/api/books", (req, res) => {
  res.json(loadBooks().map((b) => {
    const ready = hasProject(b.id);
    let progress = null;
    if (ready) {
      try {
        const p = loadProject(b.id);
        const bodies = p.targetSegments.filter((s) => s.kind === "body");
        const done = bodies.filter((s) => s.status !== "untranslated" && (s.targetText || "").trim()).length;
        progress = { total: bodies.length, done, chapters: p.chapters.length };
      } catch {}
    }
    return { ...b, ready, progress, languages: languagesFor(b) };
  }));
});

// --- Import a new book from the browser (file arrives base64 in JSON) ---
app.post("/api/import", express.json({ limit: "60mb" }), async (req, res) => {
  try {
    const { fileName, dataBase64, title, titleSource, author, sourceLang, targetLang, label } = req.body || {};
    if (!fileName || !dataBase64) return res.status(400).json({ error: "fileName and dataBase64 required" });
    const ext = path.extname(String(fileName)).toLowerCase();
    if (![".docx", ".md", ".txt"].includes(ext))
      return res.status(400).json({ error: "Supported manuscript types: .docx, .md, .txt" });
    const buffer = Buffer.from(String(dataBase64), "base64");
    if (!buffer.length) return res.status(400).json({ error: "empty file" });

    // Preview mode: parse + chapter detection only, nothing written.
    if (req.body.dryRun) {
      const preview = await importManuscript("preview", buffer, ext, { dryRun: true });
      return res.json({ ok: true, ...preview });
    }

    const bookId = slugFromTitle(title || path.basename(fileName, ext), loadBooks().map((b) => b.id));
    const out = await importManuscript(bookId, buffer, ext, {
      title: title || path.basename(fileName, ext),
      titleSource: titleSource || "", author: author || "",
      sourceLang: sourceLang || "", targetLang: targetLang || "",
      label: label || title || bookId, sourceFileName: String(fileName),
    });
    clearRulesCache();       // language pair affects the digest header
    watchBook(bookId);       // live exchange folder for the new book
    res.json({ ok: true, bookId, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Project ---
app.get("/api/project", (req, res) => {
  try {
    const book = bookOf(req);
    const project = loadProject(book);
    // Attach the resolved language pair so the UI can label the two panes.
    res.json({ ...project, book: { ...project.book, languages: languagesFor(bookById(book)) } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Inline edit / apply-from-chat save.
app.patch("/api/segment/:id", (req, res) => {
  const book = bookOf(req);
  const { id } = req.params;
  const { targetText, origin, synonym } = req.body || {};
  if (typeof targetText !== "string") {
    return res.status(400).json({ error: "targetText (string) required" });
  }
  try {
    const project = loadProject(book);
    const seg = project.targetSegments.find((s) => s.id === id);
    if (!seg) return res.status(404).json({ error: "segment not found" });

    const prev = seg.targetText;
    if (prev === targetText) return res.json(seg); // no-op

    const fromStatus = seg.status;
    seg.history = seg.history || [];
    seg.history.push({ ts: new Date().toISOString(), from: prev, fromStatus });
    if (seg.history.length > 50) seg.history.shift();

    seg.targetText = targetText;
    seg.status = "edited";

    // Word-level + paragraph-level edit signal. A synonym pick carries which word was
    // swapped and what alternatives were on offer (otherwise indistinguishable from a
    // manual rewrite).
    appendEvent(book, {
      type: "edit", segId: id, from: prev, to: targetText, fromStatus,
      origin: origin === "synonym" ? "synonym" : "manual",
      synonym: origin === "synonym" ? (synonym || null) : undefined,
    });

    saveProject(book, project);
    broadcast(book, "segment-updated", { id: seg.id, status: seg.status, targetText: seg.targetText });
    res.json(seg);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Resolve a suggestion (choose alternative / keep / accept rewrite / flag).
app.post("/api/segment/:id/decide", (req, res) => {
  const book = bookOf(req);
  try {
    const out = decide(book, req.params.id, req.body || {});
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    broadcast(book, "segment-updated", {
      id: out.seg.id, status: out.seg.status, targetText: out.seg.targetText,
      hesitations: out.seg.hesitations, claudeSuggestions: out.seg.claudeSuggestions,
    });
    res.json(out.seg);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Export a clean delivery file (.docx for KDP, or .epub) ---
app.post("/api/export", async (req, res) => {
  try {
    const format = String(req.query.format || req.body?.format || "docx");
    const out = format === "epub" ? await exportEpub(bookOf(req)) : await exportDocx(bookOf(req));
    res.json({ ok: true, format, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Training dataset: build SFT/DPO/eval files from the captured editorial signal ---
app.post("/api/export-dataset", (req, res) => {
  try { res.json({ ok: true, ...exportDataset(bookOf(req)) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Dataset + model-eval stats for the dashboard (per book).
app.get("/api/training/stats", (req, res) => {
  try { res.json(datasetStats(bookOf(req))); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Synonyms: instant offline thesaurus + glossary ---
app.get("/api/synonyms", (req, res) => {
  try { res.json(getSynonyms(req.query.word || "", bookOf(req))); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// In-context synonyms. If an external provider is enabled, answer it directly;
// otherwise hand it to Claude via the file protocol. Either way the result
// arrives over SSE as a "synonyms" event (no chat involved).
app.post("/api/synonyms/ask", async (req, res) => {
  const book = bookOf(req);
  const { word, segmentId, context, reqId } = req.body || {};
  if (!word) return res.status(400).json({ error: "word required" });
  // Reject a bad client reqId (path-traversal defense-in-depth; writeRequest also
  // contains it) and use a collision-resistant fallback — the old nanosecond-only
  // id collided under rapid synonym requests, overwriting a pending syn-*.json.
  const safeReqId = typeof reqId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(reqId) ? reqId : null;
  const rid = safeReqId || ("r" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
  try {
    const ext = resolveFeature("synonyms");
    if (ext) {
      res.json({ ok: true, reqId: rid, via: ext.provider });
      try {
        const options = await llmSynonyms(ext, word, context, languagesFor(bookById(book)));
        broadcast(book, "synonyms", { word, options, reqId: rid, via: ext.provider });
        broadcast(book, "usage", getUsage());
      } catch (e) {
        broadcast(book, "synonyms", { word, options: [], reqId: rid, error: String(e.message || e) });
      }
      return;
    }
    writeRequest(book, `syn-${rid}.json`, {
      kind: "synonyms", word, segmentId: segmentId || null,
      context: context || null, reqId: rid, ts: new Date().toISOString(),
    });
    res.json({ ok: true, reqId: rid });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Auto-translate a whole chapter's untranslated paragraphs ---
app.post("/api/translate-chapter", async (req, res) => {
  const book = bookOf(req);
  const { chapterId } = req.body || {};
  if (!chapterId || !/^[a-zA-Z0-9_-]+$/.test(String(chapterId)))
    return res.status(400).json({ error: "chapterId must match [a-zA-Z0-9_-]+" });
  try {
    const project = loadProject(book);
    const srcById = Object.fromEntries(project.sourceSegments.map((s) => [s.id, s]));
    const targets = project.targetSegments.filter((t) =>
      t.chapterId === chapterId && t.kind === "body" && (t.status === "untranslated" || !(t.targetText || "").trim()));
    if (!targets.length) return res.json({ ok: true, translated: 0, message: "Nothing untranslated in this chapter." });

    const items = targets.map((t, idx) => ({
      n: idx + 1, segId: t.id,
      source: (t.sourceLinks || []).map((id) => srcById[id]?.text).filter(Boolean).join(" "),
    }));

    const provider = providerSettings();
    if (provider) {
      res.json({ ok: true, started: true, count: items.length, via: provider.provider });
      try {
        const langs = languagesFor(bookById(book));
        const map = await translateItems(provider, items.map(({ n, source }) => ({ n, source })), project.book.namePolicy, buildRulesDigest(book), langs);
        const fresh = loadProject(book);
        const fById = Object.fromEntries(fresh.targetSegments.map((s) => [s.id, s]));
        const rv = rulesVersion(book);
        const done = [];
        for (const it of items) {
          const text = map[it.n]; const seg = fById[it.segId];
          if (!text || !seg) continue;
          seg.targetText = text; seg.status = "draft";
          (seg.history = seg.history || []).push({ ts: new Date().toISOString(), from: "", by: "mt:" + provider.provider, model: provider.model });
          // Capture the raw MT draft + exact model/rules so a later human edit forms a
          // (draft → final) preference pair, and so we can measure which model needs the
          // least correction for the house style.
          appendEvent(book, {
            type: "draft", segId: it.segId, sourceText: it.source,
            draftText: text, provider: provider.provider, model: provider.model, rulesVersion: rv,
          });
          done.push(seg);
        }
        saveProject(book, fresh);
        for (const seg of done) broadcast(book, "segment-updated", { id: seg.id, status: seg.status, targetText: seg.targetText });
        broadcast(book, "chapter-translated", { chapterId, filled: done.length, total: items.length, via: provider.provider });
        broadcast(book, "usage", getUsage());
      } catch (e) {
        broadcast(book, "chapter-translated", { chapterId, error: String(e.message || e) });
      }
      return;
    }

    // No provider configured — queue it for the Claude session (run /engine).
    writeRequest(book, `translate-${chapterId}-${Date.now()}.json`, {
      kind: "translate-chapter", chapterId, items, namePolicy: project.book.namePolicy, ts: new Date().toISOString(),
    });
    res.json({ ok: true, queued: true, count: items.length });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

// --- AI token/cost usage ---
app.get("/api/usage", (req, res) => res.json(getUsage()));
app.post("/api/usage/reset", (req, res) => res.json(resetUsage()));

// --- Author profile (per book) ---
// Free text about the author — who they are, how they write, what must survive
// translation. Stored as the book's style/voice.md, so it flows into the same
// house-style digest every AI call already reads (and the /engine file protocol).
const authorFile = (book) => path.join(dataDir(book), "style", "voice.md");
app.get("/api/author", (req, res) => {
  try {
    const file = authorFile(bookOf(req));
    res.json({ book: bookOf(req), text: fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/author", (req, res) => {
  try {
    const book = bookOf(req);
    const text = String(req.body?.text ?? "");
    if (text.length > 20000) return res.status(400).json({ error: "author notes too long (20k max)" });
    const file = authorFile(book);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf-8");
    clearRulesCache(); // baked into the rules digest — rebuild on next AI call
    res.json({ book, saved: true, chars: text.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Glossary / slang dictionary editor (per book) ---
// Terms live as Markdown tables the whole pipeline already reads: the synonym
// popup surfaces them (LOCKED first) and the AI digest quotes them verbatim.
// The editor edits the BOOK's file; shared data/style/ files also apply and are
// returned read-only so the full active termbase is visible in one place.
const TERM_EDITABLE = { glossary: "glossary.md", slang: "slang.md", idioms: "idioms.md" };
const termFileOf = (req) => TERM_EDITABLE[String(req.query.file || "glossary")] || null;
const bookTermPath = (book, name) => path.join(dataDir(book), "style", name);

app.get("/api/terms", (req, res) => {
  try {
    const book = bookOf(req), name = termFileOf(req);
    if (!name) return res.status(400).json({ error: "file must be glossary | slang | idioms" });
    const bookFile = bookTermPath(book, name);
    const own = fs.existsSync(bookFile) ? parseTables(fs.readFileSync(bookFile, "utf-8"), name) : [];
    // Shared rows = every hit for this filename minus the book's own file.
    const shared = styleFiles(book, name)
      .filter((p) => path.resolve(p) !== path.resolve(bookFile))
      .flatMap((p) => parseTables(fs.readFileSync(p, "utf-8"), name));
    const strip = (r) => ({ src: r.src, tgt: r.tgt, status: r.status, note: r.note });
    res.json({ book, file: name, rows: own.map(strip), shared: shared.map(strip) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/terms", (req, res) => {
  try {
    const book = bookOf(req), name = termFileOf(req);
    if (!name) return res.status(400).json({ error: "file must be glossary | slang | idioms" });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: "rows (array) required" });
    if (rows.length > 5000) return res.status(400).json({ error: "too many rows" });
    const clean = rows
      .map((r) => ({
        src: String(r.src || "").trim(), tgt: String(r.tgt || "").trim(),
        status: String(r.status || "").trim(), note: String(r.note || "").trim(),
      }))
      .filter((r) => r.src && r.tgt)
      // | breaks Markdown table cells — swap for a slash.
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.replace(/\|/g, "/")])));
    const heading = name === "slang" ? "Slang dictionary" : name === "idioms" ? "Idiom log" : "Glossary — names & locked terms";
    const md = `# ${heading}\n\nEdited in-app (Settings → Glossary). Locked terms are used verbatim by the AI\nand surface first in the word popup.\n\n| Source | Target | Status | Note |\n|--------|--------|--------|------|\n` +
      clean.map((r) => `| ${r.src} | ${r.tgt} | ${r.status} | ${r.note} |`).join("\n") + "\n";
    const file = bookTermPath(book, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md, "utf-8");
    reloadTermbase();   // word-popup lookups
    clearRulesCache();  // AI digest
    res.json({ book, file: name, saved: true, rows: clean.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Translation style sliders (per book; ?book= scopes them like everything else) ---
app.get("/api/style", (req, res) => res.json({ book: bookOf(req), values: loadStyle(bookOf(req)), sliders: STYLE_SLIDERS }));
app.post("/api/style", (req, res) => {
  try {
    const book = bookOf(req);
    const values = saveStyle(book, req.body || {});
    clearRulesCache(); // style is baked into the rules digest — rebuild on next AI call
    res.json({ book, values, sliders: STYLE_SLIDERS });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Translate ONE paragraph (double-click an untranslated paragraph) ---
app.post("/api/translate-segment", async (req, res) => {
  const book = bookOf(req);
  const { segmentId } = req.body || {};
  if (!segmentId || !/^[a-zA-Z0-9_-]+$/.test(String(segmentId)))
    return res.status(400).json({ error: "segmentId must match [a-zA-Z0-9_-]+" });
  try {
    const project = loadProject(book);
    const seg = project.targetSegments.find((s) => s.id === segmentId);
    if (!seg) return res.status(404).json({ error: "segment not found" });
    const srcById = Object.fromEntries(project.sourceSegments.map((s) => [s.id, s]));
    const source = (seg.sourceLinks || []).map((id) => srcById[id]?.text).filter(Boolean).join(" ");
    if (!source.trim()) return res.status(400).json({ error: "no source text linked to this paragraph" });

    const provider = providerSettings();
    if (provider) {
      res.json({ ok: true, started: true, via: provider.provider });
      try {
        const langs = languagesFor(bookById(book));
        const map = await translateItems(provider, [{ n: 1, source }], project.book.namePolicy, buildRulesDigest(book), langs);
        const text = map[1];
        if (!text) throw new Error("provider returned no translation");
        const fresh = loadProject(book);
        const fseg = fresh.targetSegments.find((s) => s.id === segmentId);
        if (fseg) {
          fseg.targetText = text; fseg.status = "draft";
          (fseg.history = fseg.history || []).push({ ts: new Date().toISOString(), from: "", by: "mt:" + provider.provider, model: provider.model });
          appendEvent(book, { type: "draft", segId: segmentId, sourceText: source, draftText: text, provider: provider.provider, model: provider.model, rulesVersion: rulesVersion(book) });
          saveProject(book, fresh);
          broadcast(book, "segment-updated", { id: fseg.id, status: fseg.status, targetText: fseg.targetText });
          broadcast(book, "usage", getUsage());
        }
      } catch (e) {
        broadcast(book, "segment-updated", { id: segmentId, error: String(e.message || e) });
      }
      return;
    }
    // No provider — queue for the /engine session (same shape as a 1-item chapter).
    writeRequest(book, `translate-seg-${segmentId}-${Date.now()}.json`, {
      kind: "translate-chapter", chapterId: seg.chapterId,
      items: [{ n: 1, segId: segmentId, source }],
      namePolicy: project.book.namePolicy, ts: new Date().toISOString(),
    });
    res.json({ ok: true, queued: true });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Book management: rename / delete (Library card actions) ---
app.post("/api/book/rename", (req, res) => {
  try {
    const book = bookOf(req);
    const { title, titleSource, label, author } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: "title required" });
    const books = loadBooks();
    const entry = books.find((b) => b.id === book);
    if (!entry) return res.status(404).json({ error: "book not found" });
    entry.titleTarget = String(title).trim();
    entry.label = String(label ?? title).trim() || entry.titleTarget;
    if (titleSource !== undefined) entry.titleSource = String(titleSource).trim();
    if (author !== undefined) entry.author = String(author).trim();
    fs.writeFileSync(path.join(dataDir(""), "books.json"), JSON.stringify(books, null, 2), "utf-8");
    if (hasProject(book)) {
      const project = loadProject(book);
      project.book.titleTarget = entry.titleTarget;
      if (titleSource !== undefined) project.book.titleSource = entry.titleSource;
      if (author !== undefined) project.book.author = entry.author;
      saveProject(book, project);
    }
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/book/delete", async (req, res) => {
  try {
    const book = bookOf(req);
    const books = loadBooks();
    if (!books.find((b) => b.id === book)) return res.status(404).json({ error: "book not found" });
    if (books.length === 1) return res.status(400).json({ error: "cannot delete the last book" });
    // Close the exchange watcher first — Windows refuses to move a directory
    // that a watcher still has open.
    const w = watchers.get(book);
    if (w) { watchers.delete(book); await w.close().catch(() => {}); }
    // Never hard-delete a manuscript: move the data folder to data/_trash/.
    const from = dataDir(book);
    if (fs.existsSync(from)) {
      const trash = path.join(dataDir(""), "_trash");
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(from, path.join(trash, `${book}-${Date.now()}`));
    }
    const next = books.filter((b) => b.id !== book);
    fs.writeFileSync(path.join(dataDir(""), "books.json"), JSON.stringify(next, null, 2), "utf-8");
    res.json({ ok: true, movedToTrash: true, remaining: next.map((b) => b.id) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Engine config (which AI answers Synonyms / Chat) ---
app.get("/api/engine/config", (req, res) => res.json(publicConfig()));
app.post("/api/engine/config", (req, res) => {
  try { saveConfig(req.body || {}); res.json(publicConfig()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Live updates ---
app.get("/api/events", sseHandler);

// --- Chat with Claude (over the shared-file protocol) ---
app.get("/api/chat", (req, res) => {
  try { res.json(readChat(bookOf(req))); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/chat", async (req, res) => {
  const book = bookOf(req);
  const { text, segmentId, selectedText } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "empty message" });
  try {
    const project = loadProject(book);
    const seg = segmentId ? project.targetSegments.find((s) => s.id === segmentId) : null;
    const sourceText = seg ? (seg.sourceLinks || []).map((sid) =>
      project.sourceSegments.find((s) => s.id === sid)?.text).filter(Boolean).join("\n") : "";

    const turn = { role: "editor", text: text.trim(), segmentId: segmentId || null,
      selectedText: selectedText || null, sourceText: sourceText || null, ts: new Date().toISOString() };
    appendChat(book, turn);
    res.json(turn); // echo the editor turn immediately

    const ext = resolveFeature("chat");
    if (ext) {
      // Answer with the external provider — STILL save the reply to chat.jsonl.
      try {
        const { reply, proposedText } = await llmChat(ext, { text: turn.text, sourceText, targetText: seg?.targetText }, buildRulesDigest(book), languagesFor(bookById(book)));
        const aiTurn = { role: "claude", via: ext.provider, text: reply,
          proposedText: proposedText || null, segmentId: segmentId || null, ts: new Date().toISOString() };
        appendChat(book, aiTurn);
        broadcast(book, "chat-message", aiTurn);
        broadcast(book, "usage", getUsage());
      } catch (e) {
        const errTurn = { role: "claude", via: ext.provider, text: `(${ext.provider} error — ${String(e.message || e)})`, ts: new Date().toISOString() };
        appendChat(book, errTurn);
        broadcast(book, "chat-message", errTurn);
      }
    } else {
      // Fallback: hand to Claude via the file protocol.
      const stamp = turn.ts.replace(/[:.]/g, "-");
      writeRequest(book, `chat-${stamp}.json`, {
        kind: "chat", text: turn.text, segmentId: segmentId || null,
        selectedText: selectedText || null, targetText: seg?.targetText || null,
        sourceText, ts: turn.ts,
      });
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Static frontend ---
app.use(express.static(WEB_DIR));
app.get("*", (req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

// Start a file-watcher per book that has data on disk.
for (const b of loadBooks()) {
  if (hasProject(b.id)) watchBook(b.id);
}

app.listen(PORT, HOST, () => {
  console.log(`BookTranslator running at http://localhost:${PORT}`);
});
