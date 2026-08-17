// Translation-style preferences, set with sliders in Settings → Style.
// PER BOOK: each book stores its own data/<book>/style.config.json — a story
// collection can run raw and uncensored while a literary novel on the same desk
// runs polished. data/style.config.json (no book) acts as the project-wide
// default for books that haven't saved their own yet. Each value 0–100 is
// turned into a plain-language directive appended to the house-style digest for
// every AI call (chat, synonyms, translate-chapter) — and readable by the
// file-protocol engine.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const globalFile = () => path.join(DATA_DIR, "style.config.json");
const bookFile = (bookId) => bookId ? path.join(DATA_DIR, bookId, "style.config.json") : globalFile();

// key -> { label, low end, high end, default }
export const STYLE_SLIDERS = {
  fidelity:  { label: "Fidelity",           low: "Close to the source",         high: "Free & natural",           def: 50 },
  register:  { label: "Register",           low: "Raw & colloquial",            high: "Polished / literary",      def: 40 },
  rhythm:    { label: "Sentence rhythm",    low: "Mirror the source rhythm",    high: "Natural target flow",      def: 40 },
  idiom:     { label: "Local idiom",        low: "Plain neutral wording",       high: "Rich local idiom",         def: 50 },
  swearing:  { label: "Strong language",    low: "Softened",                    high: "Fully uncensored",         def: 60 },
  variation: { label: "Vary openings",      low: "Natural repetition is fine",  high: "Actively vary openings",   def: 20 },
};

const defaults = () => Object.fromEntries(Object.entries(STYLE_SLIDERS).map(([k, v]) => [k, v.def]));

function readValues(file) {
  const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
  const clean = defaults();
  for (const k of Object.keys(clean)) {
    const n = Number(saved[k]);
    if (Number.isFinite(n)) clean[k] = Math.max(0, Math.min(100, Math.round(n)));
  }
  return clean;
}

// Book's own file → project-wide default file → built-in defaults.
export function loadStyle(bookId) {
  try { return readValues(bookFile(bookId)); } catch {}
  try { return readValues(globalFile()); } catch {}
  return defaults();
}

// Saving from a book's Settings writes THAT book's file only.
export function saveStyle(bookId, next) {
  const merged = { ...loadStyle(bookId) };
  for (const k of Object.keys(STYLE_SLIDERS)) {
    const n = Number(next?.[k]);
    if (Number.isFinite(n)) merged[k] = Math.max(0, Math.min(100, Math.round(n)));
  }
  const file = bookFile(bookId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

// value -> which of the five phrasings applies
const pick = (v, texts) => texts[v < 20 ? 0 : v < 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4];

const WORDING = {
  fidelity: [
    "Stay very close to the source: sentence-by-sentence, keep structure and imagery literal wherever the target language allows.",
    "Stay close to the source; only restructure when a literal rendering is awkward.",
    "Balance fidelity with natural target-language prose — keep the author's structure where it works, rephrase where it doesn't.",
    "Prefer natural target-language prose over structural fidelity; keep meaning and tone exact, restructure freely.",
    "Translate freely: capture meaning, voice and effect; restructure sentences and images as a native writer would.",
  ],
  register: [
    "Keep the register raw and conversational — street-level, unpolished; never literary.",
    "Keep it conversational and unpolished; resist any literary elevation.",
    "Neutral register: everyday educated speech, neither slangy nor writerly.",
    "Allow a lightly polished, bookish register where the passage carries it.",
    "A polished, literary register is welcome where the text supports it (never purple).",
  ],
  rhythm: [
    "Mirror the source rhythm exactly: keep every short sentence short, keep run-ons running.",
    "Follow the source rhythm closely; small smoothing only where the target language demands it.",
    "Keep the author's rhythm as the default but let the target language breathe where it must.",
    "Favour natural target-language pacing; preserve deliberate rhythm effects (refrains, one-word paragraphs).",
    "Repace freely into natural target-language flow — but never remove deliberate structural effects.",
  ],
  idiom: [
    "Use plain, neutral wording; avoid regional idiom.",
    "Mostly neutral wording with the occasional local turn of phrase.",
    "Use target-language idiom where it fits naturally; don't force it.",
    "Reach for the lived-in local idiom over the neutral phrasing when both fit.",
    "Rich, unmistakably local texture: colloquialisms and idiom of the target language wherever they land naturally.",
  ],
  swearing: [
    "Soften profanity to mild expletives.",
    "Tone profanity down a step from the source.",
    "Match the source intensity of profanity like-for-like.",
    "Keep profanity fully intact, crude where the source is crude.",
    "Fully uncensored: use the crude native equivalent every time, cruder rather than safer.",
  ],
  variation: [
    "Natural repetition of sentence openings is fine — do NOT rewrite consecutive identical openings.",
    "Leave repeated openings alone unless a run truly grates on the ear.",
    "Lightly vary sentence openings when three or more in a row start identically.",
    "Actively vary sentence openings (subject-drop, inversion, impersonal) while keeping the voice.",
    "Aggressively vary openings: avoid two consecutive identical starts, using subject-drop, inversion, fragments.",
  ],
};

export function styleDigest(bookId) {
  const s = loadStyle(bookId);
  const lines = Object.keys(STYLE_SLIDERS).map((k) =>
    `- ${STYLE_SLIDERS[k].label} (${s[k]}/100): ${pick(s[k], WORDING[k])}`);
  return "=== Editor style preferences for THIS book (Style sliders — set in-app; where these conflict with older notes above, the sliders win) ===\n" + lines.join("\n");
}
