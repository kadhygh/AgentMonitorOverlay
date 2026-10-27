import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageWindow } from "@amo-studio/protocol";

// The Claude subscription's quota, read the way Claude Code's /usage (and CC Switch) read it: GET /api/oauth/usage with
// the account's OAuth access token. It needs the `user:profile` scope, which the person's Claude Code login has and a
// `claude setup-token` token does not (Anthropic answers 403 oauth_scope_insufficient, checked 2026-10-14). So only the
// local login can show the percentages; with a token (only tests since 2026-10-27) Studio knows what the sessions'
// rate_limit_event messages say.

export const CLAUDE_USAGE_LABELS: Record<string, string> = {
  five_hour: "5 小时",
  seven_day: "每周",
  seven_day_opus: "Opus 每周",
  seven_day_sonnet: "Sonnet 每周",
};

export class ClaudeUsageError extends Error {}

/**
 * The access token of the person's Claude Code login, read (never written) from `.credentials.json` in their config
 * dir. Null when there is none; an expired one is reported, since only Claude Code itself renews it (renewing here
 * would rotate the refresh token under its feet).
 */
export function localAccessToken(dir: string, now = Date.now()): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
  const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < now) throw new ClaudeUsageError("本机 Claude Code 的登录已过期：用一次 Claude（Studio 或终端里都行）后会自动续期");
  return oauth.accessToken;
}

/** Asks the account for its quota windows (5 小时, 每周, and the per-model weekly ones when the plan has them). */
export async function fetchClaudeUsage(baseUrl: string, token: string, timeoutMs = 15_000): Promise<UsageWindow[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/oauth/usage`, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new ClaudeUsageError("本机 Claude Code 的登录已失效：在终端运行 claude 重新登录");
  if (res.status === 403) throw new ClaudeUsageError("这个登录没有读取用量的权限");
  if (!res.ok) throw new ClaudeUsageError(`读不到 Claude 的用量（HTTP ${res.status}）`);
  const body = (await res.json()) as Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined>;
  const windows: UsageWindow[] = [];
  for (const [key, label] of Object.entries(CLAUDE_USAGE_LABELS)) {
    const w = body[key];
    if (!w || typeof w !== "object") continue;
    const used = typeof w.utilization === "number" ? w.utilization : null;
    windows.push({
      label,
      usedPercent: used === null ? null : Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: typeof w.resets_at === "string" && w.resets_at ? new Date(w.resets_at).toISOString() : null,
    });
  }
  return windows;
}
