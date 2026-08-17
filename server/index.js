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
import { languagesFor } from "./config.js";
import { exportDocx } from "./export/exportDocx.js";
import { getSynonyms } from "./synonyms.js";
import { resolveFeature, publicConfig, saveConfig, providerSettings } from "./engineConfig.js";
import { llmSynonyms, llmChat } from "./llm.js";
import { translateItems } from "./translate.js";
import { buildRulesDigest, rulesVersion, clearRulesCache } from "./translationContext.js";
import { importManuscript, slugFromTitle } from "./import/importCore.js";
import { appendEvent } from "./training/events.js";
import { exportDataset, datasetStats } from "./training/exportDataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(PROJECT_ROOT, "web");
const PORT = process.env.PORT || 4319;

// Resolve the active book from ?book=, validated against the registry.
const bookOf = (req) => {
  const b = (req.query.book || defaultBookId()).toString();
  return isValidBook(b) ? b : defaultBookId();
};
const hasProject = (id) => fs.existsSync(path.join(dataDir(id), "project.json"));

const app = express();
app.use(express.json({ limit: "4mb" }));

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

    const bookId = slugFromTitle(title || path.basename(fileName, ext), loadBooks().map((b) => b.id));
    const out = await importManuscript(bookId, buffer, ext, {
      title: title || path.basename(fileName, ext),
      titleSource: titleSource || "", author: author || "",
      sourceLang: sourceLang || "", targetLang: targetLang || "",
      label: label || title || bookId, sourceFileName: String(fileName),
    });
    clearRulesCache();       // language pair affects the digest header
    startWatcher(bookId);    // live exchange folder for the new book
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

// --- Export a clean delivery .docx ---
app.post("/api/export", async (req, res) => {
  try {
    const out = await exportDocx(bookOf(req));
    res.json({ ok: true, ...out });
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
  if (hasProject(b.id)) startWatcher(b.id);
}

app.listen(PORT, () => {
  console.log(`BookTranslator running at http://localhost:${PORT}`);
});
