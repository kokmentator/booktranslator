// Engine config: which AI answers Synonyms and Chat. Stored in
// data/engine.config.json (holds your API key — gitignored, stays on your machine).
// When a feature is OFF (or provider "claude"), it falls back to the built-in
// Claude file/session path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(__dirname, "..", "data", "engine.config.json");

// Presets for OpenAI-compatible providers. baseUrl/model can be overridden in the
// config; "custom" lets you point anywhere. (Verified/adjusted from research.)
// Verified June 2026 (research). All OpenAI-compatible, Bearer auth.
// GLM Flash models are genuinely free (rate-limited); GLM-5.2 / DeepSeek-V4 /
// Kimi K2.7 are paid (cheap). baseUrl/model overridable in the UI (e.g. swap to
// the China endpoints open.bigmodel.cn / api.moonshot.cn).
export const PRESETS = {
  claude:     { label: "Claude (built-in session)", baseUrl: "", path: "", model: "" },
  // --- free tiers (no card for GLM/Gemini/Groq; free models for the rest) ---
  "glm-free": { label: "Zhipu GLM — Flash (FREE)",   baseUrl: "https://api.z.ai/api/paas/v4",                       path: "/chat/completions", model: "glm-4.7-flash" },
  gemini:     { label: "Google Gemini — Flash (FREE)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", path: "/chat/completions", model: "gemini-2.5-flash" },
  groq:       { label: "Groq (FREE)",                baseUrl: "https://api.groq.com/openai/v1",                     path: "/chat/completions", model: "openai/gpt-oss-20b" },
  openrouter: { label: "OpenRouter — free models",   baseUrl: "https://openrouter.ai/api/v1",                       path: "/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free" },
  mistral:    { label: "Mistral (FREE)",             baseUrl: "https://api.mistral.ai/v1",                          path: "/chat/completions", model: "mistral-small-latest" },
  cerebras:   { label: "Cerebras (FREE)",            baseUrl: "https://api.cerebras.ai/v1",                         path: "/chat/completions", model: "llama-3.3-70b" },
  // --- paid but cheap ---
  glm:        { label: "Zhipu GLM-5.2",              baseUrl: "https://api.z.ai/api/paas/v4", path: "/chat/completions", model: "glm-5.2" },
  deepseek:   { label: "DeepSeek-V4",                baseUrl: "https://api.deepseek.com",     path: "/chat/completions", model: "deepseek-v4-flash" },
  kimi:       { label: "Moonshot Kimi K2.7",         baseUrl: "https://api.moonshot.ai/v1",   path: "/chat/completions", model: "kimi-k2.7-code" },
  custom:     { label: "Custom (OpenAI-compatible)", baseUrl: "", path: "/chat/completions", model: "" },
};

const DEFAULT = { provider: "claude", apiKey: "", model: "", baseUrl: "", synonymsEnabled: false, chatEnabled: false };

export function loadConfig() {
  try { return { ...DEFAULT, ...JSON.parse(fs.readFileSync(CONFIG, "utf-8")) }; }
  catch { return { ...DEFAULT }; }
}

export function saveConfig(next) {
  const cur = loadConfig();
  const merged = { ...cur, ...next };
  // Never wipe a stored key when the form leaves the field blank.
  if (next.apiKey === "" || next.apiKey == null) merged.apiKey = cur.apiKey;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

// Effective provider settings for a feature, or null → use the Claude path.
export function resolveFeature(feature) {
  const c = loadConfig();
  const enabled = feature === "synonyms" ? c.synonymsEnabled : c.chatEnabled;
  if (!enabled || c.provider === "claude") return null;
  const preset = PRESETS[c.provider] || PRESETS.custom;
  const baseUrl = (c.baseUrl || preset.baseUrl || "").trim();
  const model = (c.model || preset.model || "").trim();
  if (!baseUrl || !model || !c.apiKey) return null;
  return { baseUrl, path: preset.path || "/chat/completions", model, apiKey: c.apiKey, provider: c.provider };
}

// The configured provider regardless of the per-feature toggles — used by
// "Translate chapter" (which works whenever a provider + key are set up).
export function providerSettings() {
  const c = loadConfig();
  if (c.provider === "claude") return null;
  const preset = PRESETS[c.provider] || PRESETS.custom;
  const baseUrl = (c.baseUrl || preset.baseUrl || "").trim();
  const model = (c.model || preset.model || "").trim();
  if (!baseUrl || !model || !c.apiKey) return null;
  return { baseUrl, path: preset.path || "/chat/completions", model, apiKey: c.apiKey, provider: c.provider };
}

// Safe view for the UI — never returns the key itself.
export function publicConfig() {
  const c = loadConfig();
  return {
    provider: c.provider || "claude",
    model: c.model || "",
    baseUrl: c.baseUrl || "",
    hasKey: !!c.apiKey,
    synonymsEnabled: !!c.synonymsEnabled,
    chatEnabled: !!c.chatEnabled,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, model: v.model }])),
  };
}
