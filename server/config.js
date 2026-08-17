// Project-wide configuration: the language pair and where the house-style files live.
//
// Nothing here is hardcoded to a particular language. A book declares its own pair
// in data/books.json; anything it leaves out falls back to data/config.json, and
// anything that leaves out falls back to the built-in default below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Used when neither the book nor data/config.json says otherwise.
const FALLBACK = {
  sourceLang: { code: "en", name: "English" },
  targetLang: { code: "es", name: "Spanish" },
  imprint: "",
};

let warnedMissingStyle = false;

export function loadConfig() {
  try { return { ...FALLBACK, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) }; }
  catch { return { ...FALLBACK }; }
}

// Accepts "German" or { code, name } and always returns { code, name }.
const NAME_TO_CODE = {
  english: "en", spanish: "es", german: "de", french: "fr", italian: "it",
  portuguese: "pt", dutch: "nl", polish: "pl", czech: "cs", slovak: "sk",
  russian: "ru", ukrainian: "uk", japanese: "ja", chinese: "zh", korean: "ko",
  arabic: "ar", turkish: "tr", swedish: "sv", norwegian: "no", danish: "da",
  finnish: "fi", hungarian: "hu", romanian: "ro", greek: "el", hebrew: "he",
};
function normaliseLang(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") {
    return { code: NAME_TO_CODE[value.toLowerCase()] || value.slice(0, 2).toLowerCase(), name: value };
  }
  return { code: value.code || fallback.code, name: value.name || fallback.name };
}

// The language pair in force for a book. `book` is the data/books.json entry
// (may be null — then the project-wide default applies).
export function languagesFor(book) {
  const cfg = loadConfig();
  return {
    source: normaliseLang(book?.sourceLang, normaliseLang(cfg.sourceLang, FALLBACK.sourceLang)),
    target: normaliseLang(book?.targetLang, normaliseLang(cfg.targetLang, FALLBACK.targetLang)),
  };
}

// The imprint line printed under the copyright on the exported title page.
// Empty by default — set "imprint" in data/config.json to use your own.
export function imprint() { return (loadConfig().imprint || "").trim(); }

// House-style files are read from two places, in this order:
//   1. the shared dir  — data/style/          (override with BOOKTRANSLATOR_STYLE_DIR)
//   2. the per-book dir — data/<book>/style/
// Later files win when the same filename appears in both, so a book can override
// a shared rule. Both are optional; a missing dir is not an error, but it IS
// reported once, because silently translating with no style rules at all is the
// failure mode that looks like everything is fine.
export function styleDirs(bookId) {
  const shared = process.env.BOOKTRANSLATOR_STYLE_DIR
    ? path.resolve(process.env.BOOKTRANSLATOR_STYLE_DIR)
    : path.join(DATA_DIR, "style");
  const perBook = bookId ? path.join(DATA_DIR, bookId, "style") : null;
  const dirs = [shared, perBook].filter((d) => d && fs.existsSync(d));
  if (!dirs.length && !warnedMissingStyle) {
    warnedMissingStyle = true;
    console.warn(
      `[BookTranslator] No house-style files found (looked in ${shared}` +
      (perBook ? ` and ${perBook}` : "") + ").\n" +
      "  Translations will run on the model's default instincts only.\n" +
      "  See docs/house-style.md to set your own rules."
    );
  }
  return dirs;
}

// Resolve one style filename across the style dirs; returns every hit, shared first.
export function styleFiles(bookId, name) {
  return styleDirs(bookId)
    .map((d) => path.join(d, name))
    .filter((p) => fs.existsSync(p));
}
