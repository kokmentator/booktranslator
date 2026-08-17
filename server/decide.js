// Resolve a paragraph's suggestions: choose an alternative, keep the current
// wording, accept a whole-paragraph AI rewrite, or flag it for a redo.
import { loadProject, saveProject } from "./store.js";
import { writeRequest } from "./watch.js";
import { appendEvent } from "./training/events.js";
import { rulesVersion } from "./translationContext.js";

function sourceTextOf(project, seg) {
  return (seg.sourceLinks || [])
    .map((sid) => project.sourceSegments.find((s) => s.id === sid)?.text)
    .filter(Boolean).join("\n");
}

function needsDecision(h) { return (h.kind === "alt" || h.kind === "uncertain") && !h.resolved; }

function recomputeStatus(seg) {
  if (seg.status === "flagged") return;
  const open = (seg.hesitations || []).some(needsDecision);
  const claude = seg.claudeSuggestions && (seg.claudeSuggestions.options || []).length;
  if (open || claude) seg.status = "suggested";
  else seg.status = seg.appliedChange ? "edited" : "accepted";
}

function replaceFirst(text, span, replacement) {
  const i = text.indexOf(span);
  if (i < 0) return { text, ok: false };
  return { text: text.slice(0, i) + replacement + text.slice(i + span.length), ok: true };
}

export function decide(bookId, id, body) {
  const project = loadProject(bookId);
  const seg = project.targetSegments.find((s) => s.id === id);
  if (!seg) return { error: "segment not found", code: 404 };

  const { action } = body || {};
  seg.history = seg.history || [];
  const before = seg.targetText;

  if (action === "choose") {
    const h = (seg.hesitations || [])[body.hesitationIndex];
    if (!h) return { error: "hesitation not found", code: 400 };
    const replacement = (h.options || [])[body.optionIndex];
    if (replacement == null) return { error: "option not found", code: 400 };
    const r = replaceFirst(seg.targetText, h.span, replacement);
    seg.targetText = r.text;
    h.resolved = true; h.chosen = replacement;
    if (r.ok) seg.appliedChange = true;
    appendEvent(bookId, {
      type: "hesitation-decision", segId: id, span: h.span,
      options: h.options || [], chosen: replacement, kept: false,
      reasoning: h.reasoning || "", sourceText: sourceTextOf(project, seg),
    });
  } else if (action === "keep") {
    const h = (seg.hesitations || [])[body.hesitationIndex];
    if (!h) return { error: "hesitation not found", code: 400 };
    h.resolved = true; h.chosen = h.span;
    appendEvent(bookId, {
      type: "hesitation-decision", segId: id, span: h.span,
      options: h.options || [], chosen: h.span, kept: true,
      reasoning: h.reasoning || "", sourceText: sourceTextOf(project, seg),
    });
  } else if (action === "chooseClaude") {
    const opts = seg.claudeSuggestions?.options || [];
    const opt = opts[body.optionIndex];
    if (!opt) return { error: "option not found", code: 400 };
    const chosenText = opt.text || opt;
    // Capture the full preference set BEFORE claudeSuggestions is nulled — this is
    // the DPO gold (chosen vs the alternatives the editor rejected) that the app
    // otherwise discards forever.
    appendEvent(bookId, {
      type: "choose-claude", segId: id, sourceText: sourceTextOf(project, seg),
      chosen: { text: chosenText, rationale: opt.rationale || "" },
      rejected: opts.filter((_, i) => i !== body.optionIndex)
        .map((o) => ({ text: o.text || o, rationale: o.rationale || "" })),
      note: seg.claudeSuggestions?.note || "",
      model: seg.claudeSuggestions?.model || null,
      rulesVersion: rulesVersion(bookId),
    });
    seg.targetText = chosenText;
    seg.appliedChange = true;
    seg.claudeSuggestions = null;
  } else if (action === "dismissClaude") {
    seg.claudeSuggestions = null;
  } else if (action === "flag") {
    seg.status = "flagged";
    const src = (seg.sourceLinks || []).map((sid) => project.sourceSegments.find((s) => s.id === sid)?.text).filter(Boolean).join("\n");
    writeRequest(bookId, `redo-${id}.json`, {
      kind: "retranslate", segmentId: id, sourceText: src,
      currentText: seg.targetText, reason: body.reason || "", ts: new Date().toISOString(),
    });
    saveProject(bookId, project);
    return { seg };
  } else {
    return { error: "unknown action", code: 400 };
  }

  if (before !== seg.targetText) {
    seg.history.push({ ts: new Date().toISOString(), from: before, fromStatus: seg.status, by: "decide" });
    if (seg.history.length > 50) seg.history.shift();
  }
  recomputeStatus(seg);
  saveProject(bookId, project);
  return { seg };
}
