import { useEffect, useState } from "react";
import type { Session, TeamSend, TeamThread } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { upsertById, useLiveResource } from "../host/live.js";

// 会话里用中转 (2026-10-30, plans/done/relay-in-sessions.md): what a session asks to send through AMO 中转 waits here for the
// person — on its task's page and in Focus — every time, auto mode or not (it goes to a real person, as them). Once
// sent, the task's card and page say whom it waits on; the reply goes back into the session by itself.

/** The sends the Host lists (pending ones, and those decided in the last day), kept current. */
export function useTeamSends(link: HostLink | null): TeamSend[] {
  const [sends] = useLiveResource<TeamSend[]>(
    { load: link ? () => call(link, "GET /api/teamrelay/sends", {}) : null, initial: [], onEvent: (cur, e) => (e.type === "teamsend.upserted" ? upsertById(cur, e.send) : cur) },
    [link],
  );
  return sends;
}

/** The 中转 sessions this computer's sessions sent, as last seen, kept current. */
export function useTeamThreads(link: HostLink | null): TeamThread[] {
  const [threads] = useLiveResource<TeamThread[]>(
    { load: link ? () => call(link, "GET /api/teamrelay/threads", {}) : null, initial: [], onEvent: (cur, e) => (e.type === "teamthreads.changed" ? e.threads : cur) },
    [link],
  );
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

/** How long 「X 已接手」 stays on the task's page and card: a day (then it is one done session among others). */
export const TAKEN_SHOWN_MS = 24 * 60 * 60_000;

/**
 * 已接手，不用回复 (2026-11-05): the sessions' threads the person asked took on without replying, in the last day, newest
 * first — said on the page and the card, while nothing goes into the session (the user: an accepted review needs no
 * message back).
 */
export function teamTaken(threads: readonly TeamThread[], sessions: readonly Pick<Session, "id">[], now = Date.now()): TeamThread[] {
  const ids = new Set(sessions.map((s) => s.id));
  return threads.filter((t) => t.state === "done" && t.takenAt && now - t.takenAt < TAKEN_SHOWN_MS && ids.has(t.sessionId)).sort((a, b) => b.takenAt! - a.takenAt!);
}

/** 「✓ 程序老李 已接手「背包上限存哪」，不用回复」. */
export const takenText = (t: TeamThread) => `✓ ${t.to} 已接手「${t.title}」，不用回复`;

/** Whether Studio can open threads in the AMO 中转 client here (it found one); asked once per page. */
function useRelayAvailable(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.amo?.relayAvailable?.().then((v) => alive && setOn(v === true));
    return () => {
      alive = false;
    };
  }, []);
  return on;
}

/** 在中转里打开 (2026-11-05, J2/J3): the thread in the AMO 中转 client. */
function OpenInRelay({ threadId }: { threadId: string }) {
  return (
    <button type="button" className="btn-ghost small" title="在 AMO 中转里打开这个会话" data-testid="open-in-relay" onClick={() => void window.amo?.openInRelay?.(threadId)}>
      在中转里打开
    </button>
  );
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
  const relay = useRelayAvailable();
  // Each thread waited on, oldest first, with a way to it in 中转 (2026-11-05: one row per thread, not per person).
  const now = Date.now();
  const open = threads.filter((t) => t.state === "open" && ids.has(t.sessionId)).sort((a, b) => a.since - b.since);
  const taken = teamTaken(threads, sessions, now);
  if (!pending.length && !open.length && !taken.length) return null;
  return (
    <div className="teamsend-banner" data-testid="teamsend-banner">
      {pending.map((s) => (
        <TeamSendCard key={s.id} link={link} send={s} />
      ))}
      {open.map((t) => (
        <span key={t.threadId} className="teamsend-wait" data-testid="team-wait">
          <span className="teamsend-wait-text">
            ◐ 等 {t.to} 回复（中转）· 已等 {waitedText(now - t.since)} · {t.title}
          </span>
          {relay && <OpenInRelay threadId={t.threadId} />}
        </span>
      ))}
      {taken.map((t) => (
        <span key={t.threadId} className="teamsend-wait taken" data-testid="team-taken" title="对方看过了，不需要回复；这个会话不会再收到消息">
          <span className="teamsend-wait-text">{takenText(t)}</span>
          {relay && <OpenInRelay threadId={t.threadId} />}
        </span>
      ))}
    </div>
  );
}
