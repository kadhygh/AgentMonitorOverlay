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

/** The windows of one model's own weekly limit (UsageWindow.model). */
const CLAUDE_USAGE_MODELS: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

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

/** What `fetchClaudeUsage` reads besides the windows: the week's use by where it was spent (for host.log). */
export interface ClaudeUsageExtra {
  /** "Claude Code 100% · Chats 0% · …", as `seven_day_breakdown` gives it; null when the answer had none. */
  breakdown: string | null;
}

/**
 * Asks the account for its quota windows (5 小时, 每周, and the per-model weekly ones when the plan has them). The
 * per-model ones come as `seven_day_opus` / `seven_day_sonnet`, or — Fable, seen 2026-11-12 — only in `limits[]` as
 * a `weekly_scoped` limit with the model's name in `scope.model.display_name`.
 */
export async function fetchClaudeUsage(baseUrl: string, token: string, timeoutMs = 15_000, extra?: ClaudeUsageExtra): Promise<UsageWindow[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/oauth/usage`, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new ClaudeUsageError("本机 Claude Code 的登录已失效：在终端运行 claude 重新登录");
  if (res.status === 403) throw new ClaudeUsageError("这个登录没有读取用量的权限");
  if (!res.ok) throw new ClaudeUsageError(`读不到 Claude 的用量（HTTP ${res.status}）`);
  const body = (await res.json()) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  const percent = (v: unknown) => (typeof v === "number" ? Math.max(0, Math.min(100, Math.round(v))) : null);
  const when = (v: unknown) => (typeof v === "string" && v ? new Date(v).toISOString() : null);
  for (const [key, label] of Object.entries(CLAUDE_USAGE_LABELS)) {
    const w = body[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w !== "object") continue;
    const model = CLAUDE_USAGE_MODELS[key];
    windows.push({ label, usedPercent: percent(w.utilization), resetsAt: when(w.resets_at), ...(model ? { model } : {}) });
  }
  for (const l of Array.isArray(body.limits) ? (body.limits as Array<Record<string, unknown> | null>) : []) {
    if (!l || l.kind !== "weekly_scoped") continue;
    const name = (l.scope as { model?: { display_name?: unknown } } | null | undefined)?.model?.display_name;
    if (typeof name !== "string" || !name.trim()) continue;
    const label = `${name.trim()} 每周`;
    if (!windows.some((w) => w.label === label)) windows.push({ label, usedPercent: percent(l.percent), resetsAt: when(l.resets_at), model: name.trim() });
  }
  if (extra) {
    const rows = (body.seven_day_breakdown as { rows?: unknown } | null | undefined)?.rows;
    extra.breakdown = Array.isArray(rows)
      ? (rows as Array<{ display_name?: unknown; key?: unknown; percent?: unknown }>).map((r) => `${String(r.display_name ?? r.key ?? "?")} ${typeof r.percent === "number" ? `${r.percent}%` : "?"}`).join(" · ")
      : null;
  }
  return windows;
}
