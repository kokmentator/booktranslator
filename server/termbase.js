// Parse the project glossary / idiom log into a lookup termbase, so the synonym
// popup can surface LOCKED, project-specific terms alongside the generic thesaurus.
// Read-only over the house-style Markdown files (data/style/, data/<book>/style/).
//
// Any Markdown table with a source column and a target column works, e.g.
//
//   | Source   | Target    | Status | Note              |
//   |----------|-----------|--------|-------------------|
//   | fofrem   | sharpish  | LOCKED | Venda's register  |
import fs from "node:fs";
import { styleFiles } from "./config.js";

const FILES = ["glossary.md", "idioms.md", "slang.md"];

const CACHE = new Map(); // bookId -> { entries, idx }

const clean = (s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
const isSeparator = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));

export function parseTables(md, source) {
  const out = [];
  let header = null, cols = null;
  for (const raw of md.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("|")) { header = null; cols = null; continue; }
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    if (isSeparator(cells)) continue;
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      cols = {
        // Column 0 is the source term and column 1 the target term unless the
        // header names them. Language names are matched too, so a table headed
        // "Czech | English" or "Deutsch | Español" is understood as written.
        src: header.findIndex((h) => /source|original|^cz|czech|german|deutsch/.test(h)),
        tgt: header.findIndex((h) => /target|translation|^en|english|british|spanish|español|französisch/.test(h)),
        status: header.findIndex((h) => /status|lock/.test(h)),
        note: header.findIndex((h) => /note|comment/.test(h)),
      };
      continue;
    }
    const get = (i) => (i >= 0 && i < cells.length ? cells[i] : "");
    const tgt = clean(get(cols.tgt >= 0 ? cols.tgt : 1));
    const src = clean(get(cols.src >= 0 ? cols.src : 0));
    if (!tgt || tgt.toLowerCase() === "keep as-is") continue;
    out.push({ src, tgt, status: clean(get(cols.status)), note: clean(get(cols.note)), source });
  }
  return out;
}

function load(bookId) {
  const entries = [];
  for (const f of FILES) {
    for (const p of styleFiles(bookId, f)) {
      try { entries.push(...parseTables(fs.readFileSync(p, "utf-8"), f)); } catch {}
    }
  }
  // index: the target term + each word of it -> entry indices
  const idx = new Map();
  entries.forEach((e, ei) => {
    const keys = new Set();
    for (const term of e.tgt.split("/").map((s) => s.trim()).filter(Boolean)) {
      keys.add(term.toLowerCase());
      for (const w of term.toLowerCase().split(/[^\p{L}]+/u)) if (w.length > 2) keys.add(w);
    }
    for (const k of keys) { if (!idx.has(k)) idx.set(k, new Set()); idx.get(k).add(ei); }
  });
  return { entries, idx };
}

export function lookupGlossary(word, bookId) {
  if (!CACHE.has(bookId)) CACHE.set(bookId, load(bookId));
  const { entries, idx } = CACHE.get(bookId);
  const set = idx.get(String(word || "").toLowerCase());
  if (!set) return [];
  const rows = [...set].map((i) => entries[i]).map((e) => ({
    alternatives: e.tgt.split("/").map((s) => s.trim()).filter(Boolean),
    source: e.src, status: e.status || null, note: e.note || null, file: e.source,
  }));
  // Dedupe identical source+alternatives, preferring a row that carries a status.
  const byKey = new Map();
  for (const r of rows) {
    const key = (r.source || "").toLowerCase() + "|" + r.alternatives.join(",").toLowerCase();
    const prev = byKey.get(key);
    if (!prev || (!prev.status && r.status)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export function reloadTermbase() { CACHE.clear(); }
