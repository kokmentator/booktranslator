// Append-only training-signal log. Every editorial decision that carries ML value
// is recorded here as ONE JSON line, never truncated or overwritten — unlike
// project.json, which truncates history[] to 50 and NULLS claudeSuggestions the
// moment a rewrite is applied (destroying the rejected alternatives = the exact
// preference pair a DPO dataset is made of).
//
// Each record is stamped with { ts, type, bookId, author, segId, ... } so the
// corpus is sliceable per author and per style-revision later. Author varies per
// book and CANNOT be reconstructed afterwards — it comes from data/books.json.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../store.js";
import { bookById } from "../registry.js";

export function trainingDir(bookId) { return path.join(dataDir(bookId), "training"); }
export function eventsFile(bookId) { return path.join(trainingDir(bookId), "events.jsonl"); }

// Append a single typed event. Logging must NEVER break the editorial flow, so all
// failures are swallowed (with a console warning) rather than thrown.
export function appendEvent(bookId, event) {
  try {
    const book = bookById(bookId) || {};
    const record = {
      ts: new Date().toISOString(),
      bookId,
      author: book.author || "",
      ...event,
    };
    fs.mkdirSync(trainingDir(bookId), { recursive: true });
    fs.appendFileSync(eventsFile(bookId), JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    console.error("[training] appendEvent failed:", e.message);
  }
}

// Read back the whole log (used by export + the dashboard). Tolerates partial lines.
export function readEvents(bookId) {
  try {
    return fs.readFileSync(eventsFile(bookId), "utf-8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
