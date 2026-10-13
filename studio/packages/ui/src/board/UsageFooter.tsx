import { useCallback, useEffect, useState } from "react";
import type { AccountUsage } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

// Bottom of the left column: whether the Host runs, and how much of the GPT and Claude subscriptions is used. One
// line folded (the highest use of each account); click for every window with what is left and when it resets.

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

/** "3 小时后", "明天 09:00", "10/20 09:00". */
export function resetIn(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const mins = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "已重置";
  if (mins < 60) return `${mins} 分钟后`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} 小时后`;
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

const peak = (u: AccountUsage) => (u.windows.length ? Math.max(...u.windows.map((w) => w.usedPercent ?? 0)) : null);

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
          {usage.length === 0 && <span className="usage-note">没有订阅账号的用量可看。</span>}
          {usage.map((u) => (
            <div key={u.profileId} className="usage-acct" data-testid="usage-account">
              <div className="usage-acct-h">
                <b>{u.label}</b>
              </div>
              {u.windows.map((w) => {
                const used = w.usedPercent ?? 0;
                return (
                  <div key={w.label} className="usage-win">
                    <div className="usage-win-line">
                      <span>{w.label}</span>
                      <span className="usage-left">剩 {Math.max(0, 100 - used)}%</span>
                    </div>
                    <div className="usage-bar" aria-label={`${w.label} 已用 ${used}%`}>
                      <span className={used >= 80 ? "hot" : undefined} style={{ width: `${Math.min(100, used)}%` }} />
                    </div>
                    {w.resetsAt && <span className="usage-note">{resetIn(w.resetsAt)}重置</span>}
                  </div>
                );
              })}
              {u.note && <span className="usage-note">{u.note}</span>}
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => load(true)} disabled={loading}>
            {loading ? "正在读取…" : "刷新"}
          </button>
        </div>
      )}
      <button type="button" className="usage-toggle" aria-expanded={open} onClick={toggle} title={open ? "收起用量" : "展开 GPT / Claude 的用量"}>
        <span className={live ? "dot live" : "dot"} aria-hidden="true" />
        <span data-testid="host-status">{live ? "Host 运行中" : "Host 重新连接中…"}</span>
        <span className="usage-peaks">
          {usage.map((u) => {
            const p = peak(u);
            return (
              <span key={u.profileId} className={p !== null && p >= 80 ? "hot" : undefined}>
                {u.label} {p === null ? "—" : `${p}%`}
              </span>
            );
          })}
        </span>
      </button>
    </div>
  );
}
