// CLI wrapper around importCore: import a manuscript from the command line.
//
//   node server/import/importBook.js <bookId> <sourceFile> [options]
//
//   <sourceFile>      .docx, .md or .txt manuscript in the SOURCE language
//   --title "..."     working title shown in the app (target-language title)
//   --title-source    original title (shown next to the working title)
//   --author "..."    author name (stamped on exports + training data)
//   --source-lang     e.g. "English"  (default: project config)
//   --target-lang     e.g. "Spanish"  (default: project config)
//   --label "..."     short tab label (default: the title)
//
// The same import is available in the app itself: the "+" tab → Add a book.
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./lib.js";
import { importManuscript } from "./importCore.js";

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

const ext = path.extname(sourceFile).toLowerCase();
if (![".docx", ".md", ".txt"].includes(ext)) { console.error("Supported manuscript types: .docx, .md, .txt"); process.exit(1); }

// Stored relative to the project root when inside it, so the record is portable.
const abs = path.resolve(sourceFile);
const rel = path.relative(PROJECT_ROOT, abs);
const sourceFileName = rel.startsWith("..") ? abs : rel.replace(/\\/g, "/");

importManuscript(bookId, fs.readFileSync(sourceFile), ext, {
  title: opt("title", bookId),
  titleSource: opt("title-source", ""),
  author: opt("author", ""),
  sourceLang: opt("source-lang", ""),
  targetLang: opt("target-lang", ""),
  label: opt("label", opt("title", bookId)),
  sourceFileName,
}).then((r) => {
  console.log("Wrote", r.projectFile);
  console.log("chapters:", r.chapters, " paragraphs:", r.paragraphs);
  console.log(`Registered "${bookId}" in data/books.json — start the app and pick it from the top-left tabs.`);
}).catch((e) => { console.error(e); process.exit(1); });
