import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, DEFAULT_AUTO_COMPACT_TOKENS } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 自动压缩点 (设置 → 模型, 2026-10-17): the context size at which a session summarises its conversation by itself. Both
// CLIs otherwise wait until the context nears the model's whole window (1M for the Claude subscription), and every
// model call reads the whole context again: a session left to grow to 460k spent ~450k per call. Claude Code takes it
// as CLAUDE_CODE_AUTO_COMPACT_WINDOW (it compacts as the context nears the smaller of this and the model's window),
// Codex as `model_auto_compact_token_limit` in a thread's config.

const KEY = "settings:auto-compact-tokens";

/** The setting: tokens, or null to leave it to the CLIs. Unset: DEFAULT_AUTO_COMPACT_TOKENS. */
export function readAutoCompact(store: Store): number | null {
  const raw = store.getKv(KEY)?.value;
  if (raw === undefined) return DEFAULT_AUTO_COMPACT_TOKENS;
  if (raw === "cli") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= AUTO_COMPACT_MIN && n <= AUTO_COMPACT_MAX ? n : DEFAULT_AUTO_COMPACT_TOKENS;
}

export function writeAutoCompact(store: Store, tokens: number | null): void {
  store.setKv(KEY, tokens === null ? "cli" : String(tokens));
}

/** For a Claude process's environment. */
export function claudeAutoCompactEnv(store: Store): Record<string, string> {
  const tokens = readAutoCompact(store);
  return tokens === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(tokens) };
}

/** For a Codex thread's config (thread/start, thread/fork, thread/resume). */
export function codexAutoCompactConfig(store: Store): Record<string, unknown> {
  const tokens = readAutoCompact(store);
  return tokens === null ? {} : { model_auto_compact_token_limit: tokens };
}
