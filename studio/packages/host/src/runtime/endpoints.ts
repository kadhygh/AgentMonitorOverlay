import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileEndpoint } from "@amo-studio/protocol";

// 问题 #14 (2026-11-03, the user): 设置 → 模型 shows where Claude 订阅 and GPT send their requests. Those two run on the
// person's own Claude Code and Codex setup, and tools like ccswitch rewrite it (Claude: ~/.claude/settings.json's
// env.ANTHROPIC_BASE_URL; Codex: config.toml's model_provider and its [model_providers.<id>] base_url), so a session
// may not be talking to Anthropic or OpenAI at all. Read only, on demand; the user-level setup only (the user's call:
// a project's own settings may differ, which the page says).

export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";
export const CHATGPT_DEFAULT_URL = "https://chatgpt.com/backend-api/codex";
/** Codex's built-in providers other than openai (their addresses as Codex has them). */
const CODEX_BUILTIN: Record<string, string> = { ollama: "http://localhost:11434/v1", lmstudio: "http://localhost:1234/v1", oss: "http://localhost:11434/v1" };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Claude Code's user settings in `dir` (the person's ~/.claude, or their CLAUDE_CONFIG_DIR). */
export function claudeEndpoint(dir: string, now = new Date().toISOString()): ProfileEndpoint {
  const file = join(dir, "settings.json");
  const note = "项目自己的 .claude/settings.json 或 settings.local.json 另设了的，那个项目里以项目的为准";
  const base = { url: ANTHROPIC_DEFAULT_URL, from: null, model: null, modelFrom: null, note, readAt: now };
  if (!existsSync(file)) return base;
  let json: { env?: Record<string, unknown>; model?: unknown };
  try {
    json = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as typeof json;
  } catch (err) {
    return { ...base, problem: `读不了 ${file}：${err instanceof Error ? err.message : String(err)}` };
  }
  const env = json && typeof json.env === "object" && json.env ? json.env : {};
  const url = str(env.ANTHROPIC_BASE_URL);
  const envModel = str(env.ANTHROPIC_MODEL);
  const model = envModel ?? str(json?.model);
  return {
    ...base,
    ...(url ? { url, from: `${file} 的 env.ANTHROPIC_BASE_URL` } : {}),
    model,
    modelFrom: envModel ? `${file} 的 env.ANTHROPIC_MODEL` : model ? `${file} 的 model` : null,
  };
}

/** A TOML string value (basic or literal), or null for anything else. */
function tomlString(raw: string): string | null {
  const v = raw.trim();
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(v) ?? /^'([^']*)'/.exec(v);
  if (!m) return null;
  return v.startsWith('"') ? m[1]!.replace(/\\(["\\])/g, "$1") : m[1]!;
}

/** The key/value pairs of a config.toml, by table ("" = top level; `[model_providers."x"]` → `model_providers.x`). */
export function tomlTables(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([["", new Map()]]);
  let table = "";
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1]!
        .split(".")
        .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
        .join(".");
      if (!tables.has(table)) tables.set(table, new Map());
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const value = tomlString(kv[2]!);
    if (value !== null) tables.get(table)!.set(kv[1]!.replace(/^["'](.*)["']$/, "$1"), value);
  }
  return tables;
}

/**
 * Codex's setup in `home` (CODEX_HOME or ~/.codex): config.toml's provider (a `profile = "x"` there picks
 * [profiles.x]'s) and its base_url; for OpenAI itself OPENAI_BASE_URL, else ChatGPT's or the API's address by how
 * auth.json signs in.
 */
export function codexEndpoint(home: string, env: NodeJS.ProcessEnv = process.env, now = new Date().toISOString()): ProfileEndpoint {
  const file = join(home, "config.toml");
  const note = "codex 命令行带 -c 或 --profile 时以命令行的为准；Studio 开的会话用的就是这里的设置";
  const base = { from: null, model: null, modelFrom: null, note, readAt: now };
  let tables = new Map<string, Map<string, string>>([["", new Map()]]);
  let problem: string | undefined;
  if (existsSync(file)) {
    try {
      tables = tomlTables(readFileSync(file, "utf8"));
    } catch (err) {
      problem = `读不了 ${file}：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const top = tables.get("")!;
  const profile = top.get("profile");
  const prof = profile ? tables.get(`profiles.${profile}`) : undefined;
  const pick = (key: string): { value: string; from: string } | null => {
    const p = prof?.get(key);
    if (p) return { value: p, from: `${file} 的 [profiles.${profile}] ${key}` };
    const t = top.get(key);
    return t ? { value: t, from: `${file} 的 ${key}` } : null;
  };
  const provider = pick("model_provider");
  const model = pick("model");
  const modelPart = { model: model?.value ?? null, modelFrom: model?.from ?? null, ...(problem ? { problem } : {}) };
  const id = provider?.value ?? "openai";
  const own = tables.get(`model_providers.${id}`);
  if (own) {
    const url = own.get("base_url");
    return { ...base, ...modelPart, url: url ?? "", from: url ? `${file} 的 [model_providers.${id}] base_url` : null, ...(url ? {} : { problem: `${file} 的 [model_providers.${id}] 没写 base_url` }) };
  }
  if (id !== "openai") {
    const builtin = CODEX_BUILTIN[id];
    return { ...base, ...modelPart, url: builtin ?? "", from: provider!.from, ...(builtin ? {} : { problem: `${file} 用的 model_provider「${id}」没有对应的 [model_providers.${id}]` }) };
  }
  const envUrl = str(env.OPENAI_BASE_URL);
  if (envUrl) return { ...base, ...modelPart, url: envUrl, from: "环境变量 OPENAI_BASE_URL" };
  return { ...base, ...modelPart, url: codexSignedInWithChatGpt(home) ? CHATGPT_DEFAULT_URL : OPENAI_DEFAULT_URL };
}

/** Whether auth.json holds a ChatGPT sign-in rather than an API key (the default address differs). */
function codexSignedInWithChatGpt(home: string): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
    if (auth.auth_mode === "chatgpt") return true;
    if (auth.auth_mode === "apikey") return false;
    return !str(auth.OPENAI_API_KEY) && !!auth.tokens;
  } catch {
    return true;
  }
}
