import { useCallback, useEffect, useState } from "react";
import type { AccountUsage, ModelProfile } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { IconClock } from "../chat/icons.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { balanceText, money, useBalance, useProfiles } from "../lib/balance.js";
import { quotaOf } from "../lib/quota.js";

// Bottom of the left column: whether the Host runs, how much of the GPT and Claude subscriptions is used, and the
// balance of channels whose site tells it — the accounts 设置 → 额度 shows here. One line folded (the highest use of
// each account, each balance); click for every window with what is left and when it resets.

const OPEN_KEY = "amo.usageOpen";
const STORED_KEY = "amo.usage";
const REFRESH_MS = 5 * 60_000;

function readStored(): AccountUsage[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as AccountUsage[]) : [];
  } catch {
    return [];
  }
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

export function UsageFooter({ link, live }: { link: HostLink; live: boolean }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [usage, setUsage] = useState<AccountUsage[]>(readStored);
  const [loading, setLoading] = useState(false);
  const now = useNow(open);
  const settings = useSettings(link);
  const balances = (useProfiles(link) ?? []).filter((p) => p.balance && quotaOf(settings, p.id).footer);
  const shown = usage.filter((u) => quotaOf(settings, u.profileId).footer);

  const load = useCallback(
    (refresh: boolean) => {
      if (!link.url) return;
      setLoading(refresh);
      call(link, "GET /api/usage", {}, undefined, refresh ? { refresh: "1" } : {})
        .then((list) => {
          // A plain read without numbers keeps the numbers known from before.
          setUsage((cur) => list.map((u) => (u.windows.length || refresh ? u : (cur.find((c) => c.profileId === u.profileId) ?? u))));
          if (refresh) {
            try {
              localStorage.setItem(STORED_KEY, JSON.stringify(list));
            } catch {
              // per-viewer convenience only
            }
          }
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

  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return !v;
    });

  return (
    <div className={open ? "nav-footer open" : "nav-footer"}>
      {open && (
        <div className="usage-list" data-testid="usage-list">
          {shown.length === 0 && balances.length === 0 && <span className="usage-note">没有要显示的额度。在 设置 → 额度 里选。</span>}
          {shown.map((u) => (
            <div key={u.profileId} className="usage-acct" data-testid="usage-account">
              <b className="usage-acct-name">{u.label}</b>
              <div className="usage-acct-body">
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
          ))}
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
          {shown.map((u) => {
            const p = peak(u);
            return (
              <span key={u.profileId} className={p !== null && p >= 80 ? "hot" : undefined}>
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
