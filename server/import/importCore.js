// Core import logic: turn a manuscript (docx/md/txt buffer) into
// data/<book>/project.json and register the book in data/books.json.
// Used by both the CLI (importBook.js) and the /api/import endpoint.
import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { PROJECT_ROOT, sid, tid, buildReverseIndex, writeProject } from "./lib.js";

// Chapter detection: a paragraph that looks like a heading starts a new chapter —
//   .md:          "# Heading" / "## Heading"
//   .docx/.txt:   "Chapter 12", "Kapitola 3", "Kapitel 7", "Capítulo 2",
//                 "Chapitre 4", "Prologue"/"Prolog"/"Prólogo", "Epilogue", or an
//                 ALL-CAPS line of a few words
const HEADING_WORD = /^(#{1,3}\s+.+|(chapter|kapitola|kapitel|cap[ií]tulo|chapitre|глава)\s+[\divxlc]+.*|(prologue|prolog|pr[óo]logo|epilogue|epilog|ep[íi]logo))$/i;
const looksAllCaps = (t) => t.length <= 60 && t === t.toUpperCase() && /\p{Lu}/u.test(t) && t.split(/\s+/).length <= 8;
const isHeading = (t) => HEADING_WORD.test(t) || looksAllCaps(t);
const stripMd = (t) => t.replace(/^#{1,3}\s+/, "");

export async function parasFromBuffer(buffer, ext) {
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return buffer.toString("utf-8").split(/\r?\n\s*\r?\n|\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function registryFile() { return path.join(PROJECT_ROOT, "data", "books.json"); }

export function slugFromTitle(title, taken) {
  let base = String(title || "book").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // strip accents
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "book";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

// meta: { title, titleSource, author, sourceLang, targetLang, label, sourceFileName, dryRun }
// With dryRun: parse + detect chapters and return the preview WITHOUT writing anything.
export async function importManuscript(bookId, buffer, ext, meta = {}) {
  const paras = await parasFromBuffer(buffer, ext);
  if (!paras.length) throw new Error("No paragraphs found in the manuscript.");

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

  if (meta.dryRun) {
    return {
      dryRun: true, paragraphs: paras.length, chapters: usedChapters.length,
      chapterList: usedChapters.map((c) => ({
        id: c.id, label: c.label,
        paragraphs: sourceSegments.filter((s) => s.chapterId === c.id && s.style === "body").length,
        firstLine: (sourceSegments.find((s) => s.chapterId === c.id && s.style === "body")?.text || "").slice(0, 90),
      })),
    };
  }

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
      titleTarget: meta.title || bookId,
      titleSource: meta.titleSource || "",
      author: meta.author || "",
      namePolicy: "keep",
      sourceFile: meta.sourceFileName || "",
      sourceStats: { totalParas: paras.length, chapterCount: usedChapters.length },
    },
    chapters: usedChapters, sourceSegments, targetSegments,
  };
  buildReverseIndex(project);
  const out = writeProject(bookId, project);

  // Register the book (create or update in place).
  let books = [];
  try { books = JSON.parse(fs.readFileSync(registryFile(), "utf-8")); } catch {}
  const entry = {
    id: bookId,
    label: meta.label || meta.title || bookId,
    titleTarget: meta.title || bookId,
    titleSource: meta.titleSource || "",
    author: meta.author || "",
    ...(meta.sourceLang ? { sourceLang: meta.sourceLang } : {}),
    ...(meta.targetLang ? { targetLang: meta.targetLang } : {}),
  };
  const at = books.findIndex((b) => b.id === bookId);
  if (at >= 0) books[at] = { ...books[at], ...entry }; else books.push(entry);
  fs.writeFileSync(registryFile(), JSON.stringify(books, null, 2), "utf-8");

  return { projectFile: out, chapters: usedChapters.length, paragraphs: paras.length, entry };
}
