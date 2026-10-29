import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { relativeTime, SESSION_LOOK, type StatusLook } from "../lib/status.js";
import { FocusDetail, TO_REVIEW } from "./FocusEntry.js";
import { sessionWord, StatusWord } from "./StatusWord.js";
import { ranFor } from "./pins.js";

// 进行中 with subagents (方案 D, 2026-10-21) and 置顶 (the same day). A session counts as working while it runs or
// while subagents of its own still do; 「◐ 等待」 says it waits for them (a hollow dot until 2026-10-29). Its running subagents fold to「▸ N」 next
// to it and open to a row each (a click opens that subagent). A pinned task's session stays at the top with its
// detail always open.

/** Waiting for its subagents: the session itself is not running, some of its subagents are. */
export const WAITING_SUBS: StatusLook = { label: "等子 agent", dot: "var(--running)", text: "var(--running-text)" };

type GoTo = (sessionId: string, taskId: string | null | undefined) => void;

/** A row's status word: 完成待审核, waiting for its subagents (`ring`), or the session's own status. */
function rowWord(session: Session, look: StatusLook, ring: boolean) {
  return sessionWord(session.status, { toReview: look === TO_REVIEW, waitsSubs: ring });
}

export function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className={pinned ? "focus-pin on" : "focus-pin"}
      aria-pressed={pinned}
      aria-label={pinned ? "取消置顶" : "置顶"}
      title={pinned ? "取消置顶" : "置顶：一直放在 Focus 最上面，详情展开"}
      onClick={onToggle}
      data-testid="focus-pin"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="6" r="3.6" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 9.8V14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function SubsToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className="focus-subs-toggle"
      aria-expanded={open}
      title={open ? "收起" : `${count} 个子 agent 或委派会话在跑，展开看`}
      onClick={onToggle}
      data-testid="focus-subs-toggle"
    >
      {open ? "▾" : "▸"} {count}
    </button>
  );
}

/** Ticks while shown, for the「已跑」 times. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function SubRows({ subs, goTo }: { subs: readonly Session[]; goTo: GoTo }) {
  const now = useNow(true);
  return (
    <div className="focus-subs" data-testid="focus-subs">
      {subs.map((sub) => (
        <button key={sub.id} type="button" className="focus-sub-row" onClick={() => goTo(sub.id, sub.taskId)} title={sub.kind === "sub" ? "在工作台打开这个子 agent" : "在工作台打开这个委派会话（它开的会话）"} data-testid="focus-sub-row" data-delegated={sub.kind !== "sub" || undefined}>
          <StatusWord tone="run" />
          {sub.kind !== "sub" && (
            <svg className="focus-sub-kind" width="11" height="11" viewBox="0 0 16 16" aria-label="委派会话">
              <path d="M3.5 3v3.5A2.5 2.5 0 0 0 6 9h7" />
              <path d="M10.5 6.5 13 9l-2.5 2.5" />
            </svg>
          )}
          <span className="focus-sub-name">{sub.title || (sub.kind === "sub" ? "子 agent" : "委派会话")}</span>
          {/* A running subagent's session last changed when it started (or was resumed). */}
          <span className="focus-time">{ranFor(sub.updatedAt, now)}</span>
        </button>
      ))}
    </div>
  );
}

/** One session's row with its subagent toggle and pin, and its subagents when opened. */
function Row({
  session,
  title,
  line,
  look,
  ring,
  subs,
  subsOpen,
  onToggleSubs,
  pinned,
  onPin,
  goTo,
}: {
  session: Session;
  title: string;
  line: ReactNode;
  look: StatusLook;
  ring: boolean;
  subs: readonly Session[];
  subsOpen: boolean;
  onToggleSubs(): void;
  pinned: boolean;
  onPin?: (() => void) | undefined;
  goTo: GoTo;
}) {
  const { tone, word } = rowWord(session, look, ring);
  return (
    <>
      <div className="focus-row-line">
        <button type="button" className="focus-row" onClick={() => goTo(session.id, session.taskId)} title="在工作台打开">
          <StatusWord tone={tone} word={word} />
          <span className="focus-row-text">
            <span className="focus-title">{title}</span>
            <span className="focus-sub" style={{ color: look.text }}>
              {line}
            </span>
          </span>
          <span className="focus-time">{relativeTime(session.updatedAt)}</span>
        </button>
        {subs.length > 0 && <SubsToggle count={subs.length} open={subsOpen} onToggle={onToggleSubs} />}
        {onPin && <PinButton pinned={pinned} onToggle={onPin} />}
      </div>
      {subsOpen && subs.length > 0 && <SubRows subs={subs} goTo={goTo} />}
    </>
  );
}

/** A 进行中 entry: the session runs, or waits for its subagents. */
export function WorkingEntry({
  session,
  title,
  brief,
  subs,
  subsOpen,
  onToggleSubs,
  onPin,
  goTo,
}: {
  session: Session;
  title: string;
  brief: string;
  subs: readonly Session[];
  subsOpen: boolean;
  onToggleSubs(): void;
  onPin?: (() => void) | undefined;
  goTo: GoTo;
}) {
  const own = session.status === "running";
  const look = own ? SESSION_LOOK.running : WAITING_SUBS;
  const line = subs.length ? `${look.label} · ${brief}` : brief;
  return (
    <div className="focus-entry" data-tone="run" data-testid="focus-working-entry" data-waiting-subs={!own || undefined}>
      <Row session={session} title={title} line={line} look={{ ...look, text: "var(--text-dim)" }} ring={!own} subs={subs} subsOpen={subsOpen} onToggleSubs={onToggleSubs} pinned={false} onPin={onPin} goTo={goTo} />
    </div>
  );
}

/** A pinned task's session: on top, one line on what it does; its detail opens while it waits for the person. */
export function PinnedEntry({
  link,
  session,
  title,
  brief,
  look,
  ring,
  subs,
  subsOpen,
  onToggleSubs,
  onUnpin,
  detail,
  goTo,
}: {
  link: HostLink;
  session: Session;
  title: string;
  brief: string;
  look: StatusLook;
  ring: boolean;
  subs: readonly Session[];
  subsOpen: boolean;
  onToggleSubs(): void;
  onUnpin(): void;
  /** It waits for an approval, an answer or a plan: dealt with right here. */
  detail: boolean;
  goTo: GoTo;
}) {
  return (
    <div className={detail ? "focus-entry open pinned" : "focus-entry pinned"} data-tone={rowWord(session, look, ring).tone} data-testid="focus-pinned">
      <Row session={session} title={title} line={`${look.label} · ${brief}`} look={look} ring={ring} subs={subs} subsOpen={subsOpen} onToggleSubs={onToggleSubs} pinned onPin={onUnpin} goTo={goTo} />
      {detail && <FocusDetail link={link} session={session} />}
    </div>
  );
}
