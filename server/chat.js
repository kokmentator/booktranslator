// Persistent chat thread, one JSON object per line (chat.jsonl).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store.js";

function chatPath(bookId) { return path.join(dataDir(bookId), "chat.jsonl"); }

export function appendChat(bookId, turn) {
  const file = chatPath(bookId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(turn) + "\n", "utf-8");
  return turn;
}

export function readChat(bookId) {
  const file = chatPath(bookId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
