// Synonyms = instant offline thesaurus (Moby) + project glossary matches.
import { createRequire } from "node:module";
import { lookupGlossary } from "./termbase.js";

const require = createRequire(import.meta.url);
const thesaurus = require("thesaurus");

// The offline thesaurus is English-only (Moby). For any other target language it
// returns nothing and the glossary + AI suggestions carry the popup on their own.
export function getSynonyms(word, bookId) {
  const w = String(word || "").trim();
  const thes = w ? (thesaurus.find(w) || []) : [];
  return {
    word: w,
    glossary: lookupGlossary(w, bookId),
    thesaurus: thes.slice(0, 24),
  };
}
