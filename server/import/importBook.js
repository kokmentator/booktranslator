// Generic book importer: turn a source manuscript into data/<book>/project.json
// and register the book in data/books.json.
//
//   node server/import/importBook.js <bookId> <sourceFile> [options]
//
//   <sourceFile>      .docx, .md or .txt manuscript in the SOURCE language
//   --title "..."     working title shown in the app (target-language title)
//   --title-source    original title (shown next to the working title)
//   --author "..."    author name (stamped on exports + training data)
//   --source-lang     e.g. "English"  (default: project config / English)
//   --target-lang     e.g. "Spanish"  (default: project config / Spanish)
//   --label "..."     short tab label (default: the bookId)
//
// Chapter detection: a paragraph that looks like a heading starts a new chapter —
//   .md:          "# Heading" / "## Heading"
//   .docx/.txt:   "Chapter 12", "Kapitola 3", "Kapitel 7", "Capítulo 2",
//                 "Chapitre 4", "Prologue"/"Prolog"/"Prólogo", "Epilogue", or an
//                 ALL-CAPS line of a few words
// Everything imports as untranslated: the source fills the right pane and the
// left pane starts empty, ready to be typed or auto-translated in the app.
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, sid, tid, docxParas, buildReverseIndex, writeProject } from "./lib.js";

// --- CLI parsing -------------------------------------------------------------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, fallback = "") => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const [bookId, sourceFile] = positional;
if (!bookId || !sourceFile) {
  console.log("Usage: node server/import/importBook.js <bookId> <sourceFile> [--title ...] [--author ...] [--source-lang ...] [--target-lang ...]");
  process.exit(1);
}
if (!/^[a-z0-9_-]+$/i.test(bookId)) { console.error("bookId must be [a-z0-9_-]+"); process.exit(1); }
if (!fs.existsSync(sourceFile)) { console.error("Source file not found:", sourceFile); process.exit(1); }

// --- read the manuscript into ordered paragraphs -----------------------------
async function readParas(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".docx") return docxParas(file);
  const text = fs.readFileSync(file, "utf-8");
  return text.split(/\r?\n\s*\r?\n|\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const HEADING_WORD = /^(#{1,3}\s+.+|(chapter|kapitola|kapitel|cap[ií]tulo|chapitre|глава)\s+[\divxlc]+.*|(prologue|prolog|pr[óo]logo|epilogue|epilog|ep[íi]logo))$/i;
const looksAllCaps = (t) => t.length <= 60 && t === t.toUpperCase() && /\p{Lu}/u.test(t) && t.split(/\s+/).length <= 8;

function isHeading(t) { return HEADING_WORD.test(t) || looksAllCaps(t); }
const stripMd = (t) => t.replace(/^#{1,3}\s+/, "");

// --- build project.json ------------------------------------------------------
async function build() {
  const paras = await readParas(sourceFile);
  if (!paras.length) { console.error("No paragraphs found in", sourceFile); process.exit(1); }

  const sourceSegments = [];
  const chapters = [];
  let chapterId = "front";
  let chapterN = 0;
  const ensureChapter = (id, label) => {
    if (!chapters.find((c) => c.id === id)) chapters.push({ id, label, flags: [] });
  };
  ensureChapter("front", "Front matter");

  paras.forEach((raw, i) => {
    const text = stripMd(raw);
    const heading = isHeading(raw);
    if (heading) {
      chapterN += 1;
      chapterId = "ch" + String(chapterN).padStart(2, "0");
      ensureChapter(chapterId, text);
    }
    sourceSegments.push({
      id: sid(i), order: i, chapterId, docxIndex: i,
      style: heading ? "heading" : "body", text,
    });
  });

  // Drop an empty front-matter chapter (manuscripts that open with a heading).
  const usedChapters = chapters.filter((c) => sourceSegments.some((s) => s.chapterId === c.id));

  // Mirror every source paragraph as an untranslated target.
  const targetSegments = sourceSegments.map((s, i) => ({
    id: tid(i), order: i, chapterId: s.chapterId,
    kind: s.style === "heading" ? "heading" : "body",
    targetText: s.style === "heading" ? s.text : "",
    raw: "", hesitations: [],
    status: s.style === "heading" ? "structural" : "untranslated",
    sourceLinks: [s.id], linkConfidence: "auto", history: [],
  }));

  const project = {
    schemaVersion: 1,
    book: {
      id: bookId,
      titleTarget: opt("title", bookId),
      titleSource: opt("title-source", ""),
      author: opt("author", ""),
      namePolicy: "keep",
      // Stored relative to the project root when inside it, so the record is portable.
      sourceFile: path.relative(PROJECT_ROOT, path.resolve(sourceFile)).startsWith("..")
        ? path.resolve(sourceFile)
        : path.relative(PROJECT_ROOT, path.resolve(sourceFile)).replace(/\\/g, "/"),
      sourceStats: { totalParas: paras.length, chapterCount: usedChapters.length },
    },
    chapters: usedChapters, sourceSegments, targetSegments,
  };
  buildReverseIndex(project);
  const out = writeProject(bookId, project);

  // --- register the book -----------------------------------------------------
  const registryFile = path.join(PROJECT_ROOT, "data", "books.json");
  let books = [];
  try { books = JSON.parse(fs.readFileSync(registryFile, "utf-8")); } catch {}
  const entry = {
    id: bookId,
    label: opt("label", bookId),
    titleTarget: opt("title", bookId),
    titleSource: opt("title-source", ""),
    author: opt("author", ""),
    ...(opt("source-lang") ? { sourceLang: opt("source-lang") } : {}),
    ...(opt("target-lang") ? { targetLang: opt("target-lang") } : {}),
  };
  const at = books.findIndex((b) => b.id === bookId);
  if (at >= 0) books[at] = { ...books[at], ...entry }; else books.push(entry);
  fs.writeFileSync(registryFile, JSON.stringify(books, null, 2), "utf-8");

  console.log("Wrote", out);
  console.log("chapters:", usedChapters.length, " paragraphs:", paras.length);
  console.log(`Registered "${bookId}" in data/books.json — start the app and pick it from the top-left tabs.`);
}

build().catch((e) => { console.error(e); process.exit(1); });
