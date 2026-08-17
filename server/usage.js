// Token + cost tracking for AI calls, persisted in data/usage.json.
// OpenAI-compatible providers report token counts in their responses; per-model
// pricing isn't known here, so cost stays 0 unless a provider supplies one.
// The point is visibility: how much work the AI is doing for your book.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const FILE = path.join(DATA_DIR, "usage.json");
const empty = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byProvider: {}, firstTs: null, lastTs: null });

export function getUsage() {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf-8")) }; }
  catch { return empty(); }
}

export function recordUsage({ provider = "unknown", inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
  const u = getUsage();
  const now = new Date().toISOString();
  u.calls += 1;
  u.inputTokens += inputTokens;
  u.outputTokens += outputTokens;
  u.costUsd += costUsd;
  const p = u.byProvider[provider] || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  p.calls += 1; p.inputTokens += inputTokens; p.outputTokens += outputTokens; p.costUsd += costUsd;
  u.byProvider[provider] = p;
  if (!u.firstTs) u.firstTs = now;
  u.lastTs = now;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(u, null, 2), "utf-8"); } catch {}
  return u;
}

export function resetUsage() {
  const u = empty();
  try { fs.writeFileSync(FILE, JSON.stringify(u, null, 2), "utf-8"); } catch {}
  return u;
}
