// Turn the captured editorial signal (events.jsonl + the human-approved finals in
// project.json) into training-ready datasets:
//   • sft.jsonl  — (source text → house-style-faithful translation), human-approved only
//   • dpo.jsonl  — (prompt, chosen, rejected) preference pairs, the real moat
//   • eval.jsonl — held-out source→reference pairs for benchmarking ANY model
// Every row carries author/bookId/model/rulesVersion provenance so the corpus stays
// sliceable per author and per style-revision. NOTHING here is destructive — it only
// reads project.json + events.jsonl and writes under data/<book>/training/exports/.
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "../store.js";
import { bookById } from "../registry.js";
import { buildRulesDigest, rulesVersion } from "../translationContext.js";
import { languagesFor } from "../config.js";
import { trainingDir, readEvents } from "./events.js";

// Older events used sourceCz/draftEn; read both spellings forever.
const evSource = (e) => e.sourceText ?? e.sourceCz ?? "";
const evDraft = (e) => e.draftText ?? e.draftEn ?? "";

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
// Treat whitespace/casing-only differences as "no change" (not a real preference).
const trivial = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

// Cheap, length-tolerant change proxy (word multiset overlap) — used for the
// "which model needs least correction" eval, avoiding O(n·m) Levenshtein on long paras.
function changeRatio(a, b) {
  const wa = norm(a).toLowerCase().split(/\s+/).filter(Boolean);
  const wb = norm(b).toLowerCase().split(/\s+/).filter(Boolean);
  if (!wa.length && !wb.length) return 0;
  const count = (arr) => arr.reduce((m, w) => ((m[w] = (m[w] || 0) + 1), m), {});
  const ca = count(wa), cb = count(wb);
  let inter = 0;
  for (const w in ca) inter += Math.min(ca[w], cb[w] || 0);
  return 1 - inter / Math.max(wa.length, wb.length, 1);
}

function build(bookId) {
  const project = loadProject(bookId);
  const book = bookById(bookId) || {};
  const author = book.author || "";
  const events = readEvents(bookId);
  const digest = buildRulesDigest(bookId);
  const rv = rulesVersion(bookId);

  const srcById = Object.fromEntries(project.sourceSegments.map((s) => [s.id, s]));
  const sourceOf = (seg) => (seg.sourceLinks || []).map((id) => srcById[id]?.text).filter(Boolean).join("\n");
  const langs = languagesFor(book);
  const PROMPT = (src) => `Translate to ${langs.target.name}:\n` + src;

  // Human-approved finals (edited or accepted) — the supervised targets.
  const finals = project.targetSegments.filter(
    (t) => t.kind === "body" && (t.status === "edited" || t.status === "accepted") && norm(t.targetText)
  );
  const finalById = Object.fromEntries(finals.map((s) => [s.id, s]));

  const sft = [], evalRows = [], dpo = [];
  const seen = new Set();

  finals.forEach((seg, i) => {
    const src = sourceOf(seg); if (!src) return;
    const tgt = norm(seg.targetText);
    const key = src + "\u0001" + tgt; // \u0001 = dedup-key separator
    if (seen.has(key)) return; seen.add(key);
    const meta = { author, bookId, segId: seg.id, status: seg.status, rulesVersion: rv };
    // Deterministic ~10% hold-out for eval (index-based; no RNG, so exports are reproducible).
    if (i % 10 === 7) evalRows.push({ meta, source: src, reference: tgt });
    else sft.push({ meta, messages: [
      { role: "system", content: digest },
      { role: "user", content: PROMPT(src) },
      { role: "assistant", content: tgt },
    ] });
  });

  // DPO 1: explicit suggestion-card choices (chosen vs each rejected alternative).
  for (const e of events) {
    if (e.type !== "choose-claude" || !e.chosen?.text) continue;
    for (const rej of e.rejected || []) {
      if (!rej.text || trivial(e.chosen.text, rej.text)) continue;
      dpo.push({
        meta: { author, bookId, segId: e.segId, source: "choose-claude", model: e.model || null, rulesVersion: e.rulesVersion || rv },
        prompt: PROMPT(evSource(e)), chosen: norm(e.chosen.text), rejected: norm(rej.text),
      });
    }
  }

  // DPO 2: machine draft (rejected) vs the human-approved final (chosen) for the same seg.
  const lastDraft = {};
  for (const e of events) if (e.type === "draft" && evDraft(e)) lastDraft[e.segId] = e; // last draft wins
  for (const [segId, e] of Object.entries(lastDraft)) {
    const seg = finalById[segId]; if (!seg) continue;
    const finalText = norm(seg.targetText), draftText = norm(evDraft(e));
    if (!finalText || trivial(draftText, finalText)) continue;
    dpo.push({
      meta: { author, bookId, segId, source: "draft-final", model: e.model || null, rulesVersion: e.rulesVersion || rv },
      prompt: PROMPT(evSource(e) || sourceOf(seg)), chosen: finalText, rejected: draftText,
    });
  }

  return { author, sft, evalRows, dpo, events, finals };
}

export function exportDataset(bookId) {
  const { author, sft, evalRows, dpo } = build(bookId);
  const outDir = path.join(trainingDir(bookId), "exports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const writeJsonl = (name, rows) => {
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    fs.writeFileSync(path.join(outDir, name), rows.length ? body + "\n" : "", "utf-8");
  };
  // Versioned snapshot + stable "latest" filenames.
  for (const [base, rows] of [["sft", sft], ["dpo", dpo], ["eval", evalRows]]) {
    writeJsonl(`${base}.${stamp}.jsonl`, rows);
    writeJsonl(`${base}.jsonl`, rows);
  }
  return { bookId, author, counts: { sft: sft.length, dpo: dpo.length, eval: evalRows.length }, outDir };
}

// Lightweight stats for the dashboard — recomputed without writing files.
export function datasetStats(bookId) {
  const { author, sft, evalRows, dpo, events, finals } = build(bookId);
  const byModel = {};
  for (const e of events) {
    if (e.type !== "draft" || !evDraft(e)) continue;
    const seg = finals.find((s) => s.id === e.segId); // only score drafts that reached a human-approved final
    if (!seg) continue;
    const m = e.model || e.provider || "unknown";
    const slot = (byModel[m] ||= { drafts: 0, totalChange: 0 });
    slot.drafts++; slot.totalChange += changeRatio(evDraft(e), seg.targetText);
  }
  const models = Object.entries(byModel).map(([model, v]) => ({
    model, drafts: v.drafts, avgChangeRatio: +(v.totalChange / v.drafts).toFixed(3),
  })).sort((a, b) => a.avgChangeRatio - b.avgChangeRatio);

  return {
    bookId, author,
    counts: { sft: sft.length, dpo: dpo.length, eval: evalRows.length, events: events.length, approvedFinals: finals.length },
    byModel: models,
  };
}
