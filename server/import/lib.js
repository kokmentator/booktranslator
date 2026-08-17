// Shared import helpers used by the per-book importers.
import mammoth from "mammoth";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export const sid = (n) => "s" + String(n).padStart(4, "0");
export const tid = (n) => "t" + String(n).padStart(4, "0");

// Non-empty, trimmed paragraphs from a .docx (text only).
export async function docxParas(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Index-based alignment within a section/chapter (1:1; surplus targets link to
// the last source paragraph and are flagged). Returns mismatch flags.
export function alignByIndex(targetContent, sourceContent) {
  const flags = [];
  const min = Math.min(targetContent.length, sourceContent.length);
  for (let i = 0; i < targetContent.length; i++) {
    if (i < min) {
      targetContent[i].sourceLinks = [sourceContent[i].id];
      targetContent[i].linkConfidence = "auto";
    } else if (sourceContent.length) {
      targetContent[i].sourceLinks = [sourceContent[sourceContent.length - 1].id];
      targetContent[i].linkConfidence = "unlinked";
    } else {
      targetContent[i].sourceLinks = [];
      targetContent[i].linkConfidence = "unlinked";
    }
  }
  if (targetContent.length !== sourceContent.length) {
    flags.push({ type: "count-mismatch", target: targetContent.length, source: sourceContent.length,
      delta: targetContent.length - sourceContent.length });
  }
  return flags;
}

// sourceId -> [targetIds]
export function buildReverseIndex(project) {
  const reverse = {};
  for (const t of project.targetSegments) {
    for (const s of t.sourceLinks || []) (reverse[s] ||= []).push(t.id);
  }
  for (const s of project.sourceSegments) s.targetLinks = reverse[s.id] || [];
}

export function writeProject(bookId, project) {
  const outDir = path.join(PROJECT_ROOT, "data", bookId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(project, null, 2), "utf-8");
  return path.join(outDir, "project.json");
}
