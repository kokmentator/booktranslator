// Canonical project.json store. The SERVER is the single writer (per the plan's
// file-protocol design). Atomic write (tmp+rename) with a timestamped backup.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export function dataDir(bookId) {
  return path.join(PROJECT_ROOT, "data", bookId);
}
function projectPath(bookId) {
  return path.join(dataDir(bookId), "project.json");
}

export function loadProject(bookId) {
  return JSON.parse(fs.readFileSync(projectPath(bookId), "utf-8"));
}

export function saveProject(bookId, project) {
  const dir = dataDir(bookId);
  const file = projectPath(bookId);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // backup current file before overwriting
  if (fs.existsSync(file)) {
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, `project.${ts}.json`));
    pruneBackups(backupDir, 20);
  }

  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  return project;
}

function pruneBackups(backupDir, keep) {
  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json")).sort();
  while (files.length > keep) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
  }
}

// Rebuild the source -> target reverse index after link changes.
export function rebuildReverseIndex(project) {
  const reverse = {};
  for (const t of project.targetSegments) {
    for (const sid of t.sourceLinks || []) (reverse[sid] ||= []).push(t.id);
  }
  for (const s of project.sourceSegments) s.targetLinks = reverse[s.id] || [];
}
