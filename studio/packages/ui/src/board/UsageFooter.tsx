import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AccountUsage, ModelProfile, Session } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { IconClock } from "../chat/icons.js";
import { useSettings } from "../settings/useSettings.js";
import { balanceText, money, useBalance, useProfiles } from "../lib/balance.js";
import { quotaOf } from "../lib/quota.js";
import { readStored, writeStored, readStoredJson, writeStoredJson } from "../lib/stored.js";

// Bottom of the left column: whether the Host runs, how much of the GPT and Claude subscriptions is used, and the
// balance of channels whose site tells it — the accounts 设置 → 额度 shows here. One line folded (the highest use of
// each account, each balance); click for every window with what is left and when it resets.

// Claude 多账号 (2026-11-03, the user): the Claude subscription shows one entry per account — the one in use as before,
// the others folded together under it, each with 切换 (refused while a Claude session is at work).

const OPEN_KEY = "amo.usageOpen";
const OTHERS_KEY = "amo.usageOthersOpen";
const STORED_KEY = "amo.usage";
const REFRESH_MS = 5 * 60_000;

function readSavedUsage(): AccountUsage[] {
  const v = readStoredJson(STORED_KEY);
  return Array.isArray(v) ? (v as AccountUsage[]) : [];
}

/** Time until a reset, to the minute: "34m", "1h 34m", "3d 2h 5m"; "已重置" once past. */
export function resetIn(iso: string, now = new Date()): string {
  const mins = Math.ceil((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "已重置";
  const d = Math.floor(mins / (24 * 60));
  const h = Math.floor((mins % (24 * 60)) / 60);
  const m = mins % 60;
  return [d ? `${d}d` : "", d || h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}

/** One entry of the list: a profile, or one of the Claude subscription's accounts. */
const keyOf = (u: AccountUsage) => (u.account ? `${u.profileId}|${u.account.id}` : u.profileId);

/** Whether a Claude subscription session is at work (switching accounts waits for it; the Host checks too). */
const claudeBusy = (sessions: readonly Session[]) =>
  sessions.some((s) => s.runtime === "claude" && s.profileId === "claude-subscription" && !s.archivedAt && s.kind !== "sub" && (s.status === "running" || s.status === "awaiting-approval" || s.status === "awaiting-answer"));

/** The highest known use of an account; null when it told no percentages. */
const peak = (u: AccountUsage) => {
  const known = u.windows.flatMap((w) => (w.usedPercent === null ? [] : [w.usedPercent]));
  return known.length ? Math.max(...known) : null;
};

/** The time now, again every 30 seconds (the countdowns go to the minute). */
function useNow(on: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function UsageFooter({ link, live, sessions = [] }: { link: HostLink; live: boolean; sessions?: readonly Session[] }) {
  const [open, setOpen] = useState(() => readStored(OPEN_KEY) === "1");
  const [usage, setUsage] = useState<AccountUsage[]>(readSavedUsage);
  const [loading, setLoading] = useState(false);
  const now = useNow(open);
  const settings = useSettings(link);
  const balances = (useProfiles(link) ?? []).filter((p) => p.balance && quotaOf(settings, p.id).footer);
  const shown = usage.filter((u) => quotaOf(settings, u.profileId).footer);
  // The accounts not in use, folded together under the one in use.
  const others = shown.filter((u) => u.account && !u.account.current);
  const [othersOpen, setOthersOpen] = useState(() => readStored(OTHERS_KEY) === "1");
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const busy = claudeBusy(sessions);

  const load = useCallback(
    (refresh: boolean) => {
      if (!link.url) return;
      setLoading(refresh);
      call(link, "GET /api/usage", {}, undefined, refresh ? { refresh: "1" } : {})
        .then((list) => {
          // A plain read without numbers keeps the numbers known from before.
          setUsage((cur) => list.map((u) => (u.windows.length || refresh ? u : { ...(cur.find((c) => keyOf(c) === keyOf(u)) ?? u), ...(u.account ? { account: u.account } : {}) })));
          if (refresh) writeStoredJson(STORED_KEY, list);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    },
    [link],
  );

  useEffect(() => load(false), [load]);
  // Open: read the accounts now and every few minutes.
  useEffect(() => {
    if (!open) return;
    load(true);
    const t = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [open, load]);

  async function switchTo(u: AccountUsage) {
    if (!u.account) return;
    setSwitching(u.account.id);
    setSwitchError(null);
    try {
      await call(link, "PUT /api/claude-accounts/current", {}, { id: u.account.id });
      load(false);
    } catch (err) {
      setSwitchError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setSwitching(null);
    }
  }

  const toggleOthers = () =>
    setOthersOpen((v) => {
      writeStored(OTHERS_KEY, v ? "0" : "1");
      return !v;
    });

  const toggle = () =>
    setOpen((v) => {
      writeStored(OPEN_KEY, v ? "0" : "1");
      return !v;
    });

  return (
    <div className={open ? "nav-footer open" : "nav-footer"}>
      {open && (
        <div className="usage-list" data-testid="usage-list">
          {shown.length === 0 && balances.length === 0 && <span className="usage-note">没有要显示的额度。在 设置 → 额度 里选。</span>}
          {shown
            .filter((u) => !u.account || u.account.current)
            .map((u) => (
              <UsageAccount key={keyOf(u)} usage={u} now={now} />
            ))}
          {others.length > 0 && (
            <div className="usage-others" data-testid="usage-others">
              <button type="button" className="usage-others-toggle" aria-expanded={othersOpen} onClick={toggleOthers} data-testid="usage-others-toggle">
                <span aria-hidden="true">{othersOpen ? "▾" : "▸"}</span>
                <span>其他 Claude 账号（{others.length}）</span>
                {!othersOpen && <span className="usage-others-peaks">{others.map((u) => `${u.account!.label} ${peak(u) === null ? "—" : `${peak(u)}%`}`).join(" · ")}</span>}
              </button>
              {othersOpen &&
                others.map((u) => (
                  <UsageAccount
                    key={keyOf(u)}
                    usage={u}
                    now={now}
                    action={
                      <button
                        type="button"
                        className="btn-ghost small usage-switch"
                        disabled={!!switching || busy}
                        title={busy ? "有 Claude 会话正在进行，等它结束（或停止）后再切换" : `切换到「${u.account!.label}」：之后 Claude 订阅的会话都用这个账号`}
                        onClick={() => void switchTo(u)}
                        data-testid="usage-switch"
                      >
                        {switching === u.account!.id ? "切换中…" : "切换"}
                      </button>
                    }
                  />
                ))}
              {othersOpen && busy && <span className="usage-note">有 Claude 会话正在进行，结束（或停止）后才能切换。</span>}
              {switchError && (
                <span className="usage-note error" role="alert">
                  {switchError}
                </span>
              )}
            </div>
          )}
          {balances.map((p) => (
            <BalanceAccount key={p.id} link={link} profile={p} />
          ))}
          <button type="button" className="link-btn" onClick={() => load(true)} disabled={loading}>
            {loading ? "正在读取…" : "刷新"}
          </button>
        </div>
      )}
      <button type="button" className="usage-toggle" aria-expanded={open} onClick={toggle} title={open ? "收起额度" : "展开额度：订阅用量和渠道余额"}>
        <span className={live ? "dot live" : "dot"} aria-hidden="true" />
        <span data-testid="host-status">{live ? "Host 运行中" : "Host 重新连接中…"}</span>
        <span className="usage-peaks">
          {shown.filter((u) => !u.account || u.account.current).map((u) => {
            const p = peak(u);
            return (
              <span key={keyOf(u)} className={p !== null && p >= 80 ? "hot" : undefined}>
                {u.label} {p === null ? "—" : `${p}%`}
              </span>
            );
          })}
          {balances.map((p) => (
            <BalancePeak key={p.id} link={link} profile={p} />
          ))}
        </span>
      </button>
    </div>
  );
}

/** One subscription account in the open list: its windows (what is left, when it resets); `action`: 切换. */
function UsageAccount({ usage: u, now, action }: { usage: AccountUsage; now: Date; action?: ReactNode }) {
  const other = !!u.account && !u.account.current;
  return (
    <div className={other ? "usage-acct other" : "usage-acct"} data-testid="usage-account" data-account={u.account?.id} data-current={u.account ? (u.account.current ? "1" : "0") : undefined}>
      <b className="usage-acct-name" title={u.account ? `${u.label} · ${u.account.label}` : u.label}>
        {other ? u.account!.label : u.label}
      </b>
      <div className="usage-acct-body">
        {u.account && (
          <div className="usage-win-line usage-acct-who">
            <span className="usage-acct-label" title={u.account.label}>
              {u.account.current ? `✓ 正在使用 · ${u.account.label}` : "○ 未使用"}
            </span>
            {action}
          </div>
        )}
        {u.windows.map((w) => {
          const used = w.usedPercent;
          return (
            <div key={w.label} className="usage-win" data-testid="usage-window">
              <div className="usage-win-line">
                <span>{w.label}</span>
                <span className="usage-left" title={used === null ? "账号没有告诉用了多少" : `已用 ${used}%`}>
                  {used === null ? "剩 —" : `剩 ${Math.max(0, 100 - used)}%`}
                </span>
                {w.resetsAt && (
                  <span className="usage-reset" title={`${new Date(w.resetsAt).toLocaleString()} 重置`} data-testid="usage-reset">
                    <IconClock />
                    {resetIn(w.resetsAt, now)}
                  </span>
                )}
              </div>
              <div className="usage-bar" aria-label={used === null ? `${w.label} 用量未知` : `${w.label} 已用 ${used}%`}>
                {used !== null && <span className={used >= 80 ? "hot" : undefined} style={{ width: `${Math.min(100, used)}%` }} />}
              </div>
            </div>
          );
        })}
        {u.note && <span className="usage-note">{u.note}</span>}
      </div>
    </div>
  );
}

/** A channel's balance in the open list. */
function BalanceAccount({ link, profile }: { link: HostLink; profile: ModelProfile }) {
  const { balance, loading, refresh } = useBalance(link, profile);
  return (
    <div className="usage-acct" data-testid="usage-balance">
      <b className="usage-acct-name">{profile.label}</b>
      <div className="usage-win-line">
        <span className={balance && !balance.ok ? "usage-note" : undefined}>{loading && !balance ? "正在查询…" : balance ? balanceText(balance) : "—"}</span>
        <button type="button" className="link-btn usage-query" onClick={refresh} disabled={loading}>
          查询
        </button>
      </div>
    </div>
  );
}

/** A channel's balance in the folded line: "DeepSeek ¥88.10". */
function BalancePeak({ link, profile }: { link: HostLink; profile: ModelProfile }) {
  const { balance } = useBalance(link, profile);
  return (
    <span title={balance ? balanceText(balance) : undefined}>
      {profile.label} {balance?.ok ? money(balance.remaining ?? balance.used, balance.unit) : "—"}
    </span>
  );
}
