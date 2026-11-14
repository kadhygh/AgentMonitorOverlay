import { useEffect, useMemo, useState } from "react";
import type { DecisionRequest, Session, SessionItem, TeamThread } from "@amo-studio/protocol";
import { matterMark, sessionMatters, type Matter } from "./matters.js";

// 事项清单 (2026-11-15, plans/collab-framework.md; behind 设置 → 测试功能 → 脉络): beside the conversation, the small
// loops the session in front has going — whom it asked through 中转 and for how long, which sub-session runs, what
// waits for the person — and the ones that ended. A click goes to where it stands: the row in this conversation, or
// the session that works on it.

/** How many ended matters show before 「再看 N 件」. */
const ENDED_SHOWN = 5;

export function MattersPanel({ session, sessions, threads, items, decisions, onReveal, onOpen }: {
  session: Session;
  sessions: readonly Session[];
  threads: readonly TeamThread[];
  items: readonly SessionItem[];
  decisions: readonly DecisionRequest[];
  /** Shows a row of this conversation. */
  onReveal(itemId: string): void;
  /** Goes to another session of the task. */
  onOpen(sessionId: string): void;
}) {
  // 「等了 N 分钟」 moves on while nothing else changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const matters = useMemo(() => sessionMatters({ session, sessions, threads, items, decisions, now }), [session, sessions, threads, items, decisions, now]);
  const [all, setAll] = useState(false);
  const open = matters.filter((m) => m.open);
  const ended = matters.filter((m) => !m.open);
  const go = (m: Matter) => (m.itemId ? onReveal(m.itemId) : m.sessionId ? onOpen(m.sessionId) : undefined);
  const row = (m: Matter) => {
    const reach = m.itemId ? "点一下看对话里的这一条" : m.sessionId ? "点一下去这个会话" : "";
    return (
      <button key={m.key} type="button" className={`matter ${m.state}`} disabled={!reach} title={[m.title, m.note, reach].filter(Boolean).join("\n")} onClick={() => go(m)} data-testid="matter" data-kind={m.kind} data-state={m.state}>
        <span className="matter-mark" aria-hidden="true">
          {matterMark(m.state)}
        </span>
        <span className="matter-text">
          <span className="matter-title">{m.title}</span>
          <span className="matter-note">{m.note}</span>
        </span>
      </button>
    );
  };
  return (
    <section className="mail-panel matters-panel" aria-label="这个会话的事项" data-testid="matters-panel">
      <div className="anno-head">
        <span className="anno-title">还开着的事</span>
        <span className="anno-count" data-testid="matters-open-count">
          {open.length}
        </span>
      </div>
      {open.length ? open.map(row) : <span className="matters-empty">这个会话现在没有在等的事：没有发出去等回复的中转，没有在跑的子会话，也没有等你点的审批。</span>}
      {ended.length > 0 && (
        <>
          <div className="anno-head matters-ended-head">
            <span className="anno-title">已结束的事</span>
            <span className="anno-count">{ended.length}</span>
          </div>
          {(all ? ended : ended.slice(0, ENDED_SHOWN)).map(row)}
          {ended.length > ENDED_SHOWN && (
            <button type="button" className="btn-ghost small matters-more" onClick={() => setAll(!all)} data-testid="matters-more">
              {all ? "收起" : `再看 ${ended.length - ENDED_SHOWN} 件`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
