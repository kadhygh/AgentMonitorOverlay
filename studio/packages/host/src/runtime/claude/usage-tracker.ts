import type { AccountUsage, Id, ModelProfile, UsageWindow } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { CLAUDE_USAGE_LABELS, ClaudeUsageError, fetchClaudeUsage, localAccessToken } from "./claude-usage.js";
import { readClaudeLogin } from "./claude-login.js";
import { firstLine } from "./tool-use.js";

// The Claude subscription's quota (stage 16 split out of claude-runtime.ts): from the account with the local login,
// else from the rate_limit_event messages of its sessions.

export class ClaudeUsageTracker {
  /** The subscription's quota windows, from the rate_limit_event messages of its sessions. */
  private readonly windows = new Map<Id, Map<string, UsageWindow>>();
  private readonly updatedAt = new Map<Id, string>();
  /** The account's own answer (local login), per profile. */
  private readonly account = new Map<Id, { at: number; value: AccountUsage }>();

  constructor(
    private readonly store: Store,
    private readonly opts: { localDir: string; baseUrl(profile: ModelProfile): string | undefined },
  ) {}

  /**
   * With the local login: asked from the account (/api/oauth/usage, as Claude Code's /usage does), at most every 30
   * seconds. With the token, which may not read it: what the sessions' rate_limit_event messages said (percentages
   * only near a limit, reset times).
   */
  async usage(profile: ModelProfile, refresh: boolean): Promise<AccountUsage> {
    if (readClaudeLogin(this.store) === "local") return this.accountUsage(profile, refresh);
    const windows = [...(this.windows.get(profile.id)?.values() ?? [])];
    const note = windows.some((w) => w.usedPercent !== null)
      ? null
      : "用令牌登录时查不到用量百分比（setup-token 令牌没有这个权限），只显示 Claude 告诉的重置时间。在 设置 → 模型 改用本机 Claude Code 的登录后可以看到。";
    return { profileId: profile.id, label: profile.label, windows, note, updatedAt: this.updatedAt.get(profile.id) ?? null };
  }

  private async accountUsage(profile: ModelProfile, refresh: boolean): Promise<AccountUsage> {
    const cached = this.account.get(profile.id);
    if (cached && (!refresh || Date.now() - cached.at < 30_000)) return cached.value;
    const base = { profileId: profile.id, label: profile.label };
    let value: AccountUsage;
    try {
      const token = localAccessToken(this.opts.localDir);
      if (!token) throw new ClaudeUsageError("没找到本机 Claude Code 的登录：在终端运行 claude 登录一次");
      const windows = await fetchClaudeUsage(this.opts.baseUrl(profile) || "https://api.anthropic.com", token);
      value = { ...base, windows, note: windows.length ? null : "账号没有返回用量", updatedAt: new Date().toISOString() };
    } catch (err) {
      // Keep the last numbers, say why they are not fresh.
      const message = err instanceof ClaudeUsageError ? err.message : `读不到 Claude 的用量：${firstLine(err)}`;
      value = { ...base, windows: cached?.value.windows ?? [], note: message, updatedAt: cached?.value.updatedAt ?? null };
    }
    this.account.set(profile.id, { at: Date.now(), value });
    return value;
  }

  /** A rate_limit_event of one of the profile's sessions. */
  record(profileId: Id, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    if (!info.rateLimitType) return;
    const labels: Record<string, string> = { ...CLAUDE_USAGE_LABELS, overage: "超额" };
    const used = typeof info.utilization === "number" ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
    const windows = this.windows.get(profileId) ?? new Map<string, UsageWindow>();
    windows.set(info.rateLimitType, {
      label: labels[info.rateLimitType] ?? info.rateLimitType,
      usedPercent: used === null ? null : Math.round(used),
      resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    });
    this.windows.set(profileId, windows);
    this.updatedAt.set(profileId, new Date().toISOString());
  }

  /** The latest reset among the profile's windows known to be used up and not reset yet (ms), if any. */
  usedUpUntil(profileId: Id, now: number): number | null {
    const full = [...(this.windows.get(profileId)?.values() ?? [])].filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt && Date.parse(w.resetsAt) > now).map((w) => Date.parse(w.resetsAt!));
    return full.length ? Math.max(...full) : null;
  }
}
