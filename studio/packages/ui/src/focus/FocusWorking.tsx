import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { relativeTime, SESSION_LOOK, type StatusLook } from "../lib/status.js";
import { FocusDetail } from "./FocusEntry.js";
import { ranFor } from "./pins.js";

// 进行中 with subagents (方案 D, 2026-10-21) and 置顶 (the same day). A session counts as working while it runs or
// while subagents of its own still do; a hollow dot says it waits for them. Its running subagents fold to「▸ N」 next
// to it and open to a row each (a click opens that subagent). A pinned task's session stays at the top with its
// detail always open.

/** Waiting for its subagents: the session itself is not running, some of its subagents are. */
export const WAITING_SUBS: StatusLook = { label: "等子 agent", dot: "var(--running)", text: "var(--running-text)" };

type GoTo = (sessionId: string, taskId: string | null | undefined) => void;

/** The status dot: filled, or a ring while the session waits for its subagents. */
export function StatusDot({ look, ring = false }: { look: StatusLook; ring?: boolean }) {
  return <span className={ring ? "dot ring" : "dot"} style={ring ? { borderColor: look.dot } : { background: look.dot }} data-ring={ring || undefined} />;
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
      title={open ? "收起子 agent" : `${count} 个子 agent 在跑，展开看`}
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
        <button key={sub.id} type="button" className="focus-sub-row" onClick={() => goTo(sub.id, sub.taskId)} title="在工作台打开这个子 agent" data-testid="focus-sub-row">
          <span className="dot" style={{ background: SESSION_LOOK.running.dot }} />
          <span className="focus-sub-name">{sub.title || "子 agent"}</span>
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
  return (
    <>
      <div className="focus-row-line">
        <button type="button" className="focus-row" onClick={() => goTo(session.id, session.taskId)} title="在工作台打开">
          <StatusDot look={look} ring={ring} />
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
    <div className="focus-entry" data-testid="focus-working-entry" data-waiting-subs={!own || undefined}>
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
    <div className={detail ? "focus-entry open pinned" : "focus-entry pinned"} data-testid="focus-pinned">
      <Row session={session} title={title} line={`${look.label} · ${brief}`} look={look} ring={ring} subs={subs} subsOpen={subsOpen} onToggleSubs={onToggleSubs} pinned onPin={onUnpin} goTo={goTo} />
      {detail && <FocusDetail link={link} session={session} />}
    </div>
  );
}
