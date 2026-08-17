// Watches the exchange folders for files written by an agent session (Claude Code
// or anything else that speaks the protocol in docs/agent-protocol.md), merges
// them into the canonical project.json (the server is the sole writer), and
// pushes the result to the browser over SSE.
import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadProject, saveProject } from "./store.js";
import { appendChat } from "./chat.js";
import { broadcast } from "./events.js";
import { appendEvent } from "./training/events.js";
import { rulesVersion } from "./translationContext.js";

function sourceTextOf(project, seg) {
  return (seg.sourceLinks || [])
    .map((sid) => project.sourceSegments.find((s) => s.id === sid)?.text)
    .filter(Boolean).join("\n");
}

export function exchangeDir(bookId) { return path.join(dataDir(bookId), "exchange"); }

export function ensureExchange(bookId) {
  for (const sub of ["inbox", "requests", "responses"]) {
    fs.mkdirSync(path.join(exchangeDir(bookId), sub), { recursive: true });
  }
}

// Write a request file for Claude Code to pick up (atomic).
export function writeRequest(bookId, name, obj) {
  ensureExchange(bookId);
  const requestsDir = path.join(exchangeDir(bookId), "requests");
  // Containment: `name` is built from user-controlled ids (chapterId, reqId), so
  // never let it escape requests/ via "../" or an absolute path (arbitrary file write).
  const safeName = path.basename(name);
  const rel = path.relative(requestsDir, path.join(requestsDir, safeName));
  if (safeName !== name || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`writeRequest: unsafe request filename ${JSON.stringify(name)}`);
  }
  const file = path.join(requestsDir, safeName);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  return file;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}
function consume(file) { try { fs.unlinkSync(file); } catch {} }

// Claude proposes new suggestions for a segment (e.g. after a Flag/redo).
function handleSuggest(bookId, file) {
  const msg = readJson(file);
  if (!msg || !msg.segmentId) return consume(file);
  const project = loadProject(bookId);
  const seg = project.targetSegments.find((s) => s.id === msg.segmentId);
  if (!seg) return consume(file);
  seg.claudeSuggestions = {
    options: msg.suggestions || [],
    note: msg.hesitationNote || "",
    model: msg.model || null,
    ts: new Date().toISOString(),
  };
  seg.status = "suggested";
  saveProject(bookId, project);
  consume(file);
  broadcast(bookId, "segment-updated", { id: seg.id, status: seg.status, claudeSuggestions: seg.claudeSuggestions });
}

// Claude answers a request (chat reply, or synonyms).
function handleResponse(bookId, file) {
  const msg = readJson(file);
  if (!msg) return consume(file);
  if (msg.kind === "synonyms") {
    consume(file);
    broadcast(bookId, "synonyms", msg);
    return;
  }
  if (msg.kind === "chapter-translation") {
    const project = loadProject(bookId);
    const byId = Object.fromEntries(project.targetSegments.map((s) => [s.id, s]));
    const rv = rulesVersion(bookId);
    const model = msg.model || "claude-session";
    const done = [];
    for (const t of msg.translations || []) {
      const seg = byId[t.segId];
      // `text` is the current key; `en` is still accepted for older response files.
      const incoming = typeof t.text === "string" ? t.text : (typeof t.en === "string" ? t.en : null);
      if (seg && incoming && incoming.trim()) {
        const draftText = incoming.trim();
        // Capture the raw draft so a later human edit forms a (draft → final) DPO pair.
        appendEvent(bookId, {
          type: "draft", segId: t.segId, sourceText: sourceTextOf(project, seg),
          draftText, provider: "claude", model, rulesVersion: rv,
        });
        seg.targetText = draftText; seg.status = "draft"; done.push(seg);
      }
    }
    saveProject(bookId, project);
    consume(file);
    for (const seg of done) broadcast(bookId, "segment-updated", { id: seg.id, status: seg.status, targetText: seg.targetText });
    broadcast(bookId, "chapter-translated", { chapterId: msg.chapterId, filled: done.length });
    return;
  }
  // default: chat reply
  const turn = {
    role: "claude",
    text: msg.text || "",
    proposedText: msg.proposedText || null,
    segmentId: msg.segmentId || null,
    ts: new Date().toISOString(),
  };
  appendChat(bookId, turn);
  consume(file);
  broadcast(bookId, "chat-message", turn);
}

export function startWatcher(bookId) {
  ensureExchange(bookId);
  const dir = exchangeDir(bookId);
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  watcher.on("add", (file) => {
    if (!file.endsWith(".json")) return;
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    if (rel.startsWith("inbox/")) handleSuggest(bookId, file);
    else if (rel.startsWith("responses/")) handleResponse(bookId, file);
    // requests/ are written by the app for Claude to read — we don't consume them
  });
  return watcher;
}
