// Batch-translate a chapter's paragraphs via an OpenAI-compatible provider.
import { chatComplete } from "./llm.js";

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// items: [{ n, source }]  ->  { n: translatedText }
// langs = { source: {name}, target: {name} } — the pair this book is being translated in.
// rules = the project's house-style digest (glossary, idioms, voice, editor notes).
export async function translateItems(provider, items, namePolicy, rules, langs) {
  const src = langs?.source?.name || "the source language";
  const tgt = langs?.target?.name || "the target language";
  const results = {};
  for (const group of chunk(items, 18)) {
    const numbered = group.map((x) => `[${x.n}] ${x.source}`).join("\n\n");
    const raw = await chatComplete(provider, {
      maxTokens: 4000, temperature: 0.3,
      system:
        (rules ? rules + "\n\n---\n\n" : "") +
        `TASK: Translate the numbered ${src} paragraphs below into ${tgt}, applying ALL the rules above ` +
        "(names policy, register, never elevate the language, preserve structure, the editor's confirmed idioms and glossary). " +
        `Return ONLY a JSON array like [{"n":1,"text":"<${tgt}>"}, ...] — one entry per input paragraph, same numbers, in order. ` +
        "No commentary, no markdown fences.",
      user: numbered,
    });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) continue;
    let arr;
    try { arr = JSON.parse(m[0]); } catch { continue; }
    for (const o of arr) {
      // `text` is the current key; `en` is accepted so older/hand-written responses still work.
      const out = typeof o?.text === "string" ? o.text : (typeof o?.en === "string" ? o.en : null);
      if (o && o.n != null && out !== null) results[o.n] = out.trim();
    }
  }
  return results;
}
