import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeLogin } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";

// How the Claude subscription profile signs in (设置 → 模型). "local" (the default since 2026-10-24): the person's own
// Claude Code login and config dir, like the CLI in a terminal. "token": the long-lived token from `claude setup-token`,
// with Studio's own config dir (nothing of ~/.claude is read). Test runs (AMO_STUDIO_TEST=1) default to "token", so
// they never touch the real ~/.claude. Each session keeps the way it was started (its transcript lives in that config
// dir), so switching only affects sessions started afterwards.

const KEY = "settings:claude-login";
const sessionKey = (sessionId: string) => `claude.login:${sessionId}`;

export function readClaudeLogin(store: Store, env: NodeJS.ProcessEnv = process.env): ClaudeLogin {
  const saved = store.getKv(KEY)?.value;
  if (saved === "local" || saved === "token") return saved;
  return env.AMO_STUDIO_TEST === "1" ? "token" : "local";
}

export function writeClaudeLogin(store: Store, login: ClaudeLogin): void {
  store.setKv(KEY, login);
}

/** The way a session was started; sessions from before this setting existed are "token". */
export function sessionClaudeLogin(store: Store, sessionId: string): ClaudeLogin {
  return store.getKv(sessionKey(sessionId))?.value === "local" ? "local" : "token";
}

export function rememberSessionLogin(store: Store, sessionId: string, login: ClaudeLogin): void {
  if (login === "local") store.setKv(sessionKey(sessionId), "local");
}

/** The person's Claude Code config dir: their CLAUDE_CONFIG_DIR if they set one, else ~/.claude. */
export function localClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/**
 * Whether Claude Code is signed in there. On Windows the CLI keeps its login in `.credentials.json` (only its presence
 * is checked, never read); elsewhere it is in the system keychain, so the answer is unknown (null).
 */
export function localClaudeSignedIn(dir: string): boolean | null {
  if (process.platform !== "win32") return null;
  return existsSync(join(dir, ".credentials.json"));
}
