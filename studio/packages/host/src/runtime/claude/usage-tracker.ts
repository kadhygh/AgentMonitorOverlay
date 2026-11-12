import type { AccountUsage, ModelProfile, UsageWindow } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { CLAUDE_USAGE_LABELS, ClaudeUsageError, fetchClaudeUsage, localAccessToken, type ClaudeUsageExtra } from "./claude-usage.js";
import { readClaudeLogin } from "./claude-login.js";
import { authStatus, type ClaudeAccounts } from "./accounts.js";
import { requireClaudeCode } from "./executable.js";
import { firstLine } from "./tool-use.js";

// The Claude subscription's quota (stage 16 split out of claude-runtime.ts): from the account with the local login,
// else from the rate_limit_event messages of its sessions. Claude 多账号 (2026-11-03): one answer per account, each read
// with its own dir's login; the current account first.

export class ClaudeUsageTracker {
  /** Quota windows from the rate_limit_event messages, per key (profile id, and the account for the subscription). */
  private readonly windows = new Map<string, Map<string, UsageWindow>>();
  private readonly updatedAt = new Map<string, string>();
  /** Each account's own answer (local login), per profile and account. */
  private readonly account = new Map<string, { at: number; value: AccountUsage }>();
  /** The last 7-day breakdown logged per account. */
  private readonly lastBreakdown = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly opts: { accounts: ClaudeAccounts; baseUrl(profile: ModelProfile): string | undefined; log?(line: string): void },
  ) {}

  /**
   * With the local login: asked from each account (/api/oauth/usage, as Claude Code's /usage does), at most every 30
   * seconds; one entry while there is one account, else one per account. With the token, which may not read it: what
   * the sessions' rate_limit_event messages said (percentages only near a limit, reset times).
   */
  async usage(profile: ModelProfile, refresh: boolean): Promise<AccountUsage | AccountUsage[]> {
    if (readClaudeLogin(this.store) === "local") {
      const homes = this.opts.accounts.homes();
      if (homes.length === 1) return this.accountUsage(profile, homes[0]!, refresh);
      const list = await Promise.all(homes.map(async (h) => ({ ...(await this.accountUsage(profile, h, refresh)), account: { id: h.id, label: h.label, current: h.current, name: h.name, email: h.email, plan: h.plan } })));
      return [...list.filter((u) => u.account.current), ...list.filter((u) => !u.account.current)];
    }
    const key = `${profile.id}|${this.opts.accounts.currentId()}`;
    const windows = [...(this.windows.get(key)?.values() ?? [])];
    const note = windows.some((w) => w.usedPercent !== null)
      ? null
      : "用令牌登录时查不到用量百分比（令牌没有这个权限），只显示 Claude 告诉的重置时间。";
    return { profileId: profile.id, label: profile.label, windows, note, updatedAt: this.updatedAt.get(key) ?? null };
  }

  /**
   * 远程额度 (2026-11-06): what usage() would answer, from memory only — an account never read has nothing (usage()
   * would ask it). Same shape as usage(): one entry, or one per account (current first) when there are several.
   */
  cached(profile: ModelProfile): AccountUsage | AccountUsage[] | null {
    if (readClaudeLogin(this.store) !== "local") {
      const key = `${profile.id}|${this.opts.accounts.currentId()}`;
      const windows = [...(this.windows.get(key)?.values() ?? [])];
      return windows.length ? { profileId: profile.id, label: profile.label, windows, note: null, updatedAt: this.updatedAt.get(key) ?? null } : null;
    }
    const homes = this.opts.accounts.homes();
    if (homes.length === 1) return this.account.get(`${profile.id}|${homes[0]!.id}`)?.value ?? null;
    const list = homes.flatMap((h) => {
      const v = this.account.get(`${profile.id}|${h.id}`)?.value;
      return v ? [{ ...v, account: { id: h.id, label: h.label, current: h.current, name: h.name, email: h.email, plan: h.plan } }] : [];
    });
    return list.length ? [...list.filter((u) => u.account.current), ...list.filter((u) => !u.account.current)] : null;
  }

  private async accountUsage(profile: ModelProfile, home: { id: string; dir: string; explicit: boolean; current: boolean }, refresh: boolean): Promise<AccountUsage> {
    const key = `${profile.id}|${home.id}`;
    const cached = this.account.get(key);
    if (cached && (!refresh || Date.now() - cached.at < 30_000)) return cached.value;
    const base = { profileId: profile.id, label: profile.label };
    let value: AccountUsage;
    try {
      let token: string | null;
      try {
        token = localAccessToken(home.dir);
      } catch (err) {
        // An account nobody uses now keeps an expired token: Claude Code renews it when asked for its status (it is the
        // one that may rotate the refresh token, never Studio).
        if (!(err instanceof ClaudeUsageError) || home.current) throw err;
        await this.renew(home);
        token = localAccessToken(home.dir);
      }
      if (!token) throw new ClaudeUsageError(home.current || home.id === "default" ? "没找到本机 Claude Code 的登录：在终端运行 claude 登录一次" : "这个账号还没登录：在 设置 → 模型 → Claude 里登录");
      const extra: ClaudeUsageExtra = { breakdown: null };
      const windows = await fetchClaudeUsage(this.opts.baseUrl(profile) || "https://api.anthropic.com", token, undefined, extra);
      // Claude 多账号的排查 (2026-11-12): where the week's use went (Claude Code, Chats…), into host.log when it changed —
      // an account not in use whose Claude Code share still grows is used by something else on that login.
      if (extra.breakdown && this.lastBreakdown.get(home.id) !== extra.breakdown) {
        this.lastBreakdown.set(home.id, extra.breakdown);
        if (this.opts.accounts.count() > 1) this.opts.log?.(`claude account: week of ${home.id}${home.current ? " (in use)" : ""} by where it went: ${extra.breakdown}`);
      }
      value = { ...base, windows, note: windows.length ? null : "账号没有返回用量", updatedAt: new Date().toISOString() };
    } catch (err) {
      // Keep the last numbers, say why they are not fresh.
      const message = err instanceof ClaudeUsageError ? err.message : `读不到 Claude 的用量：${firstLine(err)}`;
      value = { ...base, windows: cached?.value.windows ?? [], note: message, updatedAt: cached?.value.updatedAt ?? null };
    }
    this.account.set(key, { at: Date.now(), value });
    return value;
  }

  private async renew(home: { dir: string; explicit: boolean }): Promise<void> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k))) as Record<string, string>;
    try {
      await authStatus(requireClaudeCode(), { ...env, ...(home.explicit ? { CLAUDE_CONFIG_DIR: home.dir } : {}), DISABLE_AUTOUPDATER: "1" });
    } catch {
      // still expired: said so below
    }
  }

  /** A rate_limit_event of one of the profile's sessions (`key`: see ClaudeRuntime.limitKey). */
  record(key: string, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    if (!info.rateLimitType) return;
    const labels: Record<string, string> = { ...CLAUDE_USAGE_LABELS, overage: "超额" };
    const used = typeof info.utilization === "number" ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
    const windows = this.windows.get(key) ?? new Map<string, UsageWindow>();
    windows.set(info.rateLimitType, {
      label: labels[info.rateLimitType] ?? info.rateLimitType,
      usedPercent: used === null ? null : Math.round(used),
      resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    });
    this.windows.set(key, windows);
    this.updatedAt.set(key, new Date().toISOString());
  }

  /** The latest reset among the key's windows known to be used up and not reset yet (ms), if any. */
  usedUpUntil(key: string, now: number): number | null {
    const full = [...(this.windows.get(key)?.values() ?? [])].filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt && Date.parse(w.resetsAt) > now).map((w) => Date.parse(w.resetsAt!));
    return full.length ? Math.max(...full) : null;
  }
}
