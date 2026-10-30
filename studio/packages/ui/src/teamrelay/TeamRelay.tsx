import { useEffect, useState } from "react";
import type { Session, TeamSend, TeamThread } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

// 会话里用中转 (2026-10-30, plans/relay-in-sessions.md): what a session asks to send through AMO 中转 waits here for the
// person — on its task's page and in Focus — every time, auto mode or not (it goes to a real person, as them). Once
// sent, the task's card and page say whom it waits on; the reply goes back into the session by itself.

/** The sends the Host lists (pending ones, and those decided in the last day), kept current. */
export function useTeamSends(link: HostLink | null): TeamSend[] {
  const [sends, setSends] = useState<TeamSend[]>([]);
  useEffect(() => {
    if (!link) return;
    let live = true;
    const load = () => call(link, "GET /api/teamrelay/sends", {}).then((r) => live && setSends(r)).catch(() => undefined);
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "teamsend.upserted") setSends((cur) => (cur.some((s) => s.id === e.send.id) ? cur.map((s) => (s.id === e.send.id ? e.send : s)) : [...cur, e.send]));
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      live = false;
      off();
      offReconnect();
    };
  }, [link]);
  return sends;
}

/** The 中转 sessions this computer's sessions sent, as last seen, kept current. */
export function useTeamThreads(link: HostLink | null): TeamThread[] {
  const [threads, setThreads] = useState<TeamThread[]>([]);
  useEffect(() => {
    if (!link) return;
    let live = true;
    const load = () => call(link, "GET /api/teamrelay/threads", {}).then((r) => live && setThreads(r)).catch(() => undefined);
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "teamthreads.changed") setThreads(e.threads);
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      live = false;
      off();
      offReconnect();
    };
  }, [link]);
  return threads;
}

/** How long, in words: 「3 分钟」「2 小时」「3 天」. */
export function waitedText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}

/** The waits of these sessions: 「等 程序老李 回复（中转）· 已等 2 小时」, one per person, oldest wait first. */
export function teamWaits(threads: readonly TeamThread[], sessions: readonly Pick<Session, "id">[], now = Date.now()): string[] {
  const ids = new Set(sessions.map((s) => s.id));
  const open = threads.filter((t) => t.state === "open" && ids.has(t.sessionId)).sort((a, b) => a.since - b.since);
  const byPerson = new Map<string, TeamThread>();
  for (const t of open) if (!byPerson.has(t.to)) byPerson.set(t.to, t);
  return [...byPerson.values()].map((t) => `等 ${t.to} 回复（中转）· 已等 ${waitedText(now - t.since)}`);
}

/** One pending send: to whom, what it says and asks, the files; 发送 / 不发. */
export function TeamSendCard({ link, send, from, className = "teamsend-card" }: { link: HostLink; send: TeamSend; from?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (what: "send" | "dismiss") => {
    setBusy(true);
    setError(null);
    try {
      const out = await call(link, what === "send" ? "POST /api/teamrelay/sends/:id/send" : "POST /api/teamrelay/sends/:id/dismiss", { id: send.id });
      if (out.state === "failed") {
        setError(out.error ?? "没发出去");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className={className} role="group" aria-label="中转" data-testid="teamsend-card">
      <span className="teamsend-head">
        <span className="teamsend-mark">中转</span>
        {send.kind === "ask" ? `AI 想找 ${send.to} 确认` : `AI 想在会话里追问 ${send.to}`}
        {from && <span className="teamsend-from">· {from}</span>}
      </span>
      <span className="teamsend-title">{send.title}</span>
      <p className="teamsend-body">{send.body}</p>
      {send.questions.length > 0 && (
        <ol className="teamsend-questions">
          {send.questions.map((q, i) => (
            <li key={i}>
              {q.text}
              {q.options?.length ? <span className="teamsend-options">（{q.options.join(" / ")}）</span> : null}
            </li>
          ))}
        </ol>
      )}
      {send.files.length > 0 && <span className="teamsend-files">带上：{send.files.map((f) => f.split(/[\\/]/).pop()).join("、")}</span>}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <span className="teamsend-actions">
        <span className="teamsend-note" title="不想每次都确认：设置 → 功能 → 中转">用你的账号发出，标着「AI 代发」；回复会自动回到这个会话。</span>
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void act("dismiss")} data-testid="teamsend-dismiss">
          不发
        </button>
        <button type="button" className="btn-primary small" disabled={busy} onClick={() => void act("send")} data-testid="teamsend-send">
          发送
        </button>
      </span>
    </div>
  );
}

/** On a task's page: the sends of its sessions that wait for the person, and whom its sessions wait on in 中转. */
export function TeamRelayBanner({ link, sends, threads, sessions }: { link: HostLink; sends: readonly TeamSend[]; threads: readonly TeamThread[]; sessions: readonly Session[] }) {
  const ids = new Set(sessions.map((s) => s.id));
  const pending = sends.filter((s) => s.state === "pending" && ids.has(s.sessionId));
  const waits = teamWaits(threads, sessions);
  if (!pending.length && !waits.length) return null;
  return (
    <div className="teamsend-banner" data-testid="teamsend-banner">
      {pending.map((s) => (
        <TeamSendCard key={s.id} link={link} send={s} />
      ))}
      {waits.map((w) => (
        <span key={w} className="teamsend-wait" data-testid="team-wait">
          ◐ {w}
        </span>
      ))}
    </div>
  );
}
