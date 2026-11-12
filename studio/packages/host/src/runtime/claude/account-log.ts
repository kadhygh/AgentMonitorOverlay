import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "@amo-studio/protocol";

// Claude 多账号的排查日志 (2026-11-12, the user: 切过账号之后感觉 2 个号在一起掉额度). host.log gets, for every Claude
// Code process, which account it was started on and what decides its login — the config dir, the names (never the
// values) of the auth variables in its environment and in the settings.json it reads, the account the dir's
// .claude.json names, and what the process itself says (accountInfo) — plus each account's quota whenever it changes.
// Then a run shows whether a process ever bills an account other than the one Studio meant.

/** Variables that pick the account or bypass the login; only their names are logged. */
const AUTH_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i;

/** `CLAUDE_CONFIG_DIR=…` (or that it is unset) and the auth variables present, as one log fragment. */
export function authEnvSummary(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  const vars = Object.keys(env).filter((k) => AUTH_VARS.test(k) && env[k]);
  return `CLAUDE_CONFIG_DIR=${dir ? dir : "(unset: ~/.claude)"}${vars.length ? ` auth-vars=${vars.join(",")}` : ""}`;
}

/** What the config dir's settings.json sets that can override the login (an `env` of auth variables, apiKeyHelper…). */
export function settingsAuthSummary(dir: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "settings.json"), "utf8");
  } catch {
    return "settings.json: none";
  }
  try {
    const s = JSON.parse(raw) as { env?: Record<string, unknown>; apiKeyHelper?: unknown; forceLoginMethod?: unknown; forceLoginOrgUUID?: unknown };
    const found = [
      ...Object.keys(s.env ?? {}).filter((k) => AUTH_VARS.test(k) || /^CLAUDE_CONFIG_DIR$/i.test(k)).map((k) => `env.${k}`),
      ...(s.apiKeyHelper ? ["apiKeyHelper"] : []),
      ...(s.forceLoginMethod ? [`forceLoginMethod=${String(s.forceLoginMethod)}`] : []),
      ...(s.forceLoginOrgUUID ? ["forceLoginOrgUUID"] : []),
    ];
    return `settings.json: ${found.length ? found.join(",") : "no auth overrides"}`;
  } catch {
    return "settings.json: unreadable";
  }
}

/**
 * The account a config dir is signed in to, as its .claude.json says (`oauthAccount`: not a secret) — the dir's own
 * when CLAUDE_CONFIG_DIR is set for it, else ~/.claude.json, as the CLI looks.
 */
export function dirAccountSummary(dir: string, explicit: boolean): string {
  const file = explicit ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
  try {
    const a = (JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown; accountUuid?: unknown; organizationUuid?: unknown; organizationName?: unknown } }).oauthAccount;
    if (!a) return `.claude.json: no oauthAccount`;
    const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 8) : "?");
    return `.claude.json: ${typeof a.emailAddress === "string" ? a.emailAddress : "?"} account=${short(a.accountUuid)} org=${short(a.organizationUuid)}${typeof a.organizationName === "string" ? ` (${a.organizationName})` : ""}`;
  } catch {
    return `.claude.json: unreadable (${file})`;
  }
}

/** A quota as one short fragment: `5 小时 12% · 每周 30%`. */
export function windowsSummary(windows: readonly UsageWindow[]): string {
  return windows.length ? windows.map((w) => `${w.label} ${w.usedPercent === null ? "?" : `${w.usedPercent}%`}`).join(" · ") : "(no windows)";
}
