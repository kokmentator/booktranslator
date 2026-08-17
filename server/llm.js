// Minimal OpenAI-compatible chat client. Works for any provider that accepts the
// standard /chat/completions request (DeepSeek, Zhipu GLM, Moonshot Kimi, etc.).
import { recordUsage } from "./usage.js";

export async function chatComplete(cfg, { system, user, maxTokens = 700, temperature = 0.4 }) {
  const url = cfg.baseUrl.replace(/\/$/, "") + (cfg.path || "/chat/completions");
  const body = {
    model: cfg.model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`${cfg.provider || "provider"} ${r.status}: ${t.slice(0, 180)}`);
  }
  const data = await r.json();
  // Track how much work the AI is doing (tokens per provider; cost unknown here).
  const u = data.usage || {};
  recordUsage({
    provider: cfg.provider || "openai",
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    costUsd: 0,
  });
  return data.choices?.[0]?.message?.content ?? "";
}

// Ask for synonyms; tolerate prose around the JSON array.
export async function llmSynonyms(cfg, word, context, langs) {
  const tgt = langs?.target?.name || "target-language";
  const text = await chatComplete(cfg, {
    maxTokens: 200, temperature: 0.5,
    system: `You suggest ${tgt} synonyms for a literary translator. Reply with ONLY a JSON array of 4–7 short options (single words or short phrases) that fit the sentence. No prose, no keys.`,
    user: `Word: "${word}"\nSentence: ${context || "(no sentence given)"}`,
  });
  const m = text.match(/\[[\s\S]*\]/);
  let arr = [];
  try { arr = JSON.parse(m ? m[0] : text); } catch { arr = text.split(/[\n,]+/).map((s) => s.replace(/^[-*\d.\s"']+|["']+$/g, "").trim()); }
  return arr.filter((s) => typeof s === "string" && s && s.toLowerCase() !== word.toLowerCase()).slice(0, 8);
}

// A chat reply about a translation passage. Returns { reply, proposedText }:
// proposedText is the full revised target-language paragraph when the model proposes
// specific new wording (drives the "Apply to selection" button), else null.
export async function llmChat(cfg, { text, sourceText, targetText }, rules, langs) {
  const src = langs?.source?.name || "source";
  const tgt = langs?.target?.name || "target";
  const raw = await chatComplete(cfg, {
    maxTokens: 900, temperature: 0.5,
    system: (rules ? rules + "\n\n---\n\n" : "") +
      `You assist a ${src}→${tgt} literary translation, applying ALL the rules above. Be concise and concrete. ` +
      `Reply ONLY as a JSON object, no markdown fences: {"reply":"<your message to the editor>","proposedText":"<the FULL revised ${tgt} paragraph if you are proposing specific new wording for it, otherwise null>"}.`,
    user: `${src} source:\n${sourceText || "(none)"}\n\nCurrent ${tgt} paragraph:\n${targetText || "(none)"}\n\nEditor: ${text}`,
  });
  let reply = raw, proposedText = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o.reply === "string") {
        reply = o.reply;
        if (typeof o.proposedText === "string" && o.proposedText.trim()) proposedText = o.proposedText.trim();
      }
    } catch { /* keep raw as reply */ }
  }
  return { reply, proposedText };
}
