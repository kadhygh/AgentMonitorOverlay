import { useEffect, useState } from "react";
import type { Session, SessionWake } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

// Stage 15 (2026-10-16): a Claude session that goes on by itself. Above the composer: its loop (the agent's next wakeup
// and why) and a usage limit (when it resets, and whether Studio goes on then); the person can stop the loop or switch
// going on after the limit. Studio keeps the session's Claude Code process meanwhile (see the Host's wake.ts).

/** "11:24", or "10月17日 00:30" on another day. */
export function wakeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** A short word for lists: 「loop · 11:24」, 「等额度 · 00:30」. */
export function wakeLabel(wake: SessionWake): string {
  if (wake.limit) return wake.limit.resetsAt ? `等额度 · ${wakeTime(wake.limit.resetsAt)}` : "等额度";
  return wake.loop ? `loop · ${wakeTime(wake.loop.at)}` : "";
}

export function WakeBar({ link, session }: { link: HostLink; session: Session }) {
  const wake = session.wake;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The box follows a click at once; the session's own value takes over when the Host has it.
  const [choosing, setChoosing] = useState<boolean | null>(null);
  // The times read "in N minutes": refreshed now and then.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!wake || (!wake.loop && !wake.limit)) return null;
  const send = async (body: { stopLoop: true } | { autoContinue: boolean }) => {
    setBusy(true);
    setError(null);
    if ("autoContinue" in body) setChoosing(body.autoContinue);
    try {
      await call(link, "POST /api/sessions/:id/wake", { id: session.id }, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setChoosing(null);
    }
  };
  const limit = wake.limit && (choosing === null ? wake.limit : { ...wake.limit, autoContinue: choosing });
  const loop = wake.loop;
  return (
    <div className="wake-bar" data-testid="wake-bar" data-kind={limit ? "limit" : "loop"} role="group" aria-label={limit ? "额度用完" : "Loop"}>
      <span className="wake-bar-dot" aria-hidden="true" />
      <span className="wake-bar-text" title={limit ? limit.message : loop?.reason}>
        {limit ? (
          <>
            <b>额度用完</b>
            {limit.resetsAt ? ` · ${wakeTime(limit.resetsAt)} 恢复${soon(limit.resetsAt)}` : " · 恢复时间未知"}
            {limit.autoContinue && !limit.resetsAt ? " · 时间未知，不会自动继续" : ""}
            {loop ? " · loop 中" : ""}
          </>
        ) : (
          loop && (
            <>
              <b>Loop 中</b>
              {` · 下次 ${wakeTime(loop.at)}${soon(loop.at)}`}
              {loop.reason ? ` · ${loop.reason}` : ""}
            </>
          )
        )}
      </span>
      <span className="wake-bar-error" role="status">
        {error}
      </span>
      {limit && (
        <label className="wake-bar-check" title="额度恢复几分钟后，Claude Code 自己没接着做时，Studio 发一条消息让它继续">
          <input type="checkbox" checked={limit.autoContinue} disabled={busy} onChange={(e) => void send({ autoContinue: e.currentTarget.checked })} />
          恢复后自动继续
        </label>
      )}
      {loop && (
        <button type="button" className="btn-ghost small" disabled={busy} title="取消排好的唤醒；Studio 也不再自动继续。之后要继续，发一条消息即可" onClick={() => void send({ stopLoop: true })}>
          停止 loop
        </button>
      )}
    </div>
  );
}

/** "（12 分钟后）" within the next few hours; nothing otherwise. */
function soon(iso: string): string {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (min < 1 || min > 300) return "";
  return min < 60 ? `（${min} 分钟后）` : `（${Math.floor(min / 60)} 小时 ${min % 60} 分钟后）`;
}
