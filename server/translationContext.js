// Builds the "house style" digest — the accumulated rules, voice notes, glossary
// and confirmed idioms — so every AI translation and chat reply is grounded in
// what this project has learned, not in the model's generic instincts.
//
// The files are plain Markdown under data/style/ (shared) and data/<book>/style/
// (per book). Every one of them is optional. See docs/house-style.md.
import fs from "node:fs";
import crypto from "node:crypto";
import { styleFiles, languagesFor } from "./config.js";
import { bookById } from "./registry.js";
import { styleDigest } from "./styleConfig.js";

// filename -> per-file character cap (keeps the system prompt bounded)
const STYLE_FILES = [
  ["house-style.md", 7000, "House style — the non-negotiable rules"],
  ["voice.md", 2600, "Voice & rhythm signature of this author"],
  ["avoid-ai-style.md", 2600, "How NOT to sound machine-translated"],
  ["glossary.md", 4500, "Glossary (names & locked terms — use these exact renderings)"],
  ["idioms.md", 4500, "Idiom log (editor-confirmed choices)"],
  ["editorial.md", 2500, "Book editorial notes"],
];
const TOTAL_CAP = 16000;

const cache = new Map();

function stripFrontmatter(md) { return md.replace(/^---[\s\S]*?---\s*/, ""); }

function readCapped(bookId, name, cap) {
  // Shared first, then per-book, so a book can extend the shared rules.
  const texts = styleFiles(bookId, name).map((p) => {
    try { return stripFrontmatter(fs.readFileSync(p, "utf-8")).trim(); }
    catch { return ""; }
  }).filter(Boolean);
  if (!texts.length) return "";
  const t = texts.join("\n\n");
  return t.length > cap ? t.slice(0, cap) + "\n…(truncated)" : t;
}

export function buildRulesDigest(bookId) {
  if (cache.has(bookId)) return cache.get(bookId);
  const langs = languagesFor(bookById(bookId));
  const parts = [
    `TRANSLATION RULES & PROJECT MEMORY for ${langs.source.name} → ${langs.target.name}. ` +
    "Follow ALL of this exactly. It is the agreed house style plus the human editor's " +
    "confirmed corrections, and it overrides default translation instincts.",
  ];
  for (const [file, cap, heading] of STYLE_FILES) {
    const t = readCapped(bookId, file, cap);
    if (t) parts.push(`\n=== ${heading} (${file}) ===\n${t}`);
  }

  let digest = parts.join("\n");
  if (digest.length > TOTAL_CAP) digest = digest.slice(0, TOTAL_CAP) + "\n…(truncated)";
  // This book's Style sliders always ride along (and win over older notes above).
  digest += "\n\n" + styleDigest(bookId);
  cache.set(bookId, digest);
  return digest;
}

export function clearRulesCache() { cache.clear(); }

// A stable fingerprint of the exact house-style digest in force, stamped onto every
// draft/preference training event so each decision is tied to the rule revision that
// governed it. Cheap (buildRulesDigest is cached).
export function rulesVersion(bookId) {
  const d = buildRulesDigest(bookId);
  const hash = crypto.createHash("sha256").update(d).digest("hex").slice(0, 12);
  return `sha256:${hash}:${d.length}`;
}
