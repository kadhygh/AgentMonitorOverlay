import { useEffect, useState } from "react";
import type { Session, SessionItem, StateSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { relativeTime, SESSION_LOOK } from "../lib/status.js";
import { DecisionCard, useOpenDecisions } from "../task/DecisionPanel.js";
import { usePendingProposals } from "../board/ProposalsPanel.js";
import "./focus.css";

// The Focus window: "what needs me right now". Lists sessions waiting for approval or review, newest first; one entry
// opens to show its latest content, approvals can be granted in place, everything else goes back to the workbench.

type Approval = Extract<SessionItem, { type: "approval" }>;
const SNIPPET_MAX = 300;

export function needsMe(state: StateSnapshot): Session[] {
  return state.sessions
    .filter((s) => !s.archivedAt && (s.status === "awaiting-approval" || s.status === "awaiting-review"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Latest content worth showing: the pending approval, else the last agent reply. */
export function latestSnippet(items: readonly SessionItem[]): { text: string; approval: Approval | null } {
  const approval = [...items].reverse().find((i): i is Approval => i.type === "approval" && i.state === "pending") ?? null;
  if (approval) return { text: [approval.summary, approval.detail].filter(Boolean).join("\n"), approval };
  const reply = [...items].reverse().find((i) => i.type === "agent");
  const text = reply && reply.type === "agent" ? reply.markdown.trim() : "";
  return { text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text, approval: null };
}

/** Placeholder while the Host connects (the decision hook runs before the link exists). */
const NO_LINK = { url: "", token: "" };

export function FocusApp() {
  const host = useHostState();
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const decisions = useOpenDecisions(host.kind === "ready" ? host.link : NO_LINK);
  const proposals = usePendingProposals(host.kind === "ready" ? host.link : NO_LINK);

  // Clicks pass through the transparent window except over the panel.
  const catchMouse = (on: boolean) => window.amo?.focus?.setIgnoreMouse(!on);
  useEffect(() => () => window.amo?.focus?.setIgnoreMouse(true), []);

  if (host.kind !== "ready") {
    return (
      <div className="focus-root">
        <div className="focus-panel" onMouseEnter={() => catchMouse(true)} onMouseLeave={() => catchMouse(false)}>
          <div className="focus-head">
            <span className="focus-name">Focus</span>
            <span className="focus-dim">{host.kind === "connecting" ? "正在连接 Host…" : "未连接 Host"}</span>
          </div>
        </div>
      </div>
    );
  }

  const { state, link } = host;
  const list = needsMe(state);
  const asks = decisions.filter((d) => state.sessions.some((s) => s.id === d.sessionId && !s.archivedAt));
  const needs = list.length + asks.length + proposals.length;
  const running = state.sessions.filter((s) => !s.archivedAt && s.status === "running").length;
  const openId = open && list.some((s) => s.id === open) ? open : (list[0]?.id ?? null);
  const title = (s: Session) => state.tasks.find((t) => t.id === s.taskId)?.title || "未命名任务";

  return (
    <div className="focus-root">
      <div className="focus-panel" data-testid="focus-panel" onMouseEnter={() => catchMouse(true)} onMouseLeave={() => catchMouse(false)}>
        <div className="focus-head">
          <span className="focus-name">Focus</span>
          <span className={needs ? "focus-needs" : "focus-dim"} data-testid="focus-needs">
            {needs ? `需要你 ${needs}` : "没有待处理"}
          </span>
          <span className="focus-dim">· 运行中 {running}</span>
          <span className="spacer" />
          <button type="button" className="focus-icon" aria-label={compact ? "展开" : "收起"} onClick={() => setCompact(!compact)}>
            {compact ? "+" : "–"}
          </button>
        </div>
        {!compact && needs > 0 && (
          <div className="focus-list">
            {proposals.length > 0 && (
              // A proposal needs its prompt read (and maybe edited): only the count here, handled on the board.
              <div className="focus-entry" data-testid="focus-proposals">
                <button type="button" className="focus-row" onClick={() => void window.amo?.openInWorkbench?.({ taskId: "" })}>
                  <span className="dot" style={{ background: "var(--attention)" }} />
                  <span className="focus-row-text">
                    <span className="focus-title">{proposals.length} 条调度提案</span>
                    <span className="focus-sub">在工作台处理</span>
                  </span>
                </button>
              </div>
            )}
            {asks.map((d) => {
              const s = state.sessions.find((x) => x.id === d.sessionId)!;
              return (
                <div key={d.id} className="focus-entry open" data-testid="focus-decision">
                  <DecisionCard
                    link={link}
                    decision={d}
                    sessionTitle={`${title(s)} · ${s.title || "会话"}`}
                    className="focus-detail focus-decision"
                    onWriteElsewhere={() => void window.amo?.openInWorkbench?.({ ...(d.taskId ? { taskId: d.taskId } : {}), sessionId: d.sessionId })}
                  />
                </div>
              );
            })}
            {list.map((s) => (
              <FocusEntry
                key={s.id}
                link={link}
                session={s}
                title={title(s)}
                open={s.id === openId}
                onToggle={() => setOpen(s.id === openId ? "" : s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FocusEntry({ link, session, title, open, onToggle }: { link: HostLink; session: Session; title: string; open: boolean; onToggle(): void }) {
  const look = SESSION_LOOK[session.status];
  return (
    <div className={open ? "focus-entry open" : "focus-entry"} data-testid="focus-entry">
      <button type="button" className="focus-row" onClick={onToggle} aria-expanded={open}>
        <span className="dot" style={{ background: look.dot }} />
        <span className="focus-row-text">
          <span className="focus-title">{title}</span>
          <span className="focus-sub" style={{ color: look.text }}>
            {look.label}
            {session.title ? ` · ${session.title}` : ""}
          </span>
        </span>
        <span className="focus-time">{relativeTime(session.updatedAt)}</span>
      </button>
      {open && <FocusDetail link={link} session={session} />}
    </div>
  );
}

function FocusDetail({ link, session }: { link: HostLink; session: Session }) {
  const { items } = useSessionItems(link, session.id);
  const { text, approval } = latestSnippet(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async (a: Approval) => {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/approvals/:approvalId", { approvalId: a.approvalId }, { sessionId: session.id, decision: "accept" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="focus-detail">
      <span className="focus-snippet" data-testid="focus-snippet">
        {text || "（还没有内容）"}
      </span>
      {error && (
        <span className="focus-error" role="alert">
          {error}
        </span>
      )}
      <div className="focus-actions">
        {approval && (
          <button type="button" className="focus-approve" disabled={busy} onClick={() => void approve(approval)}>
            批准
          </button>
        )}
        <button
          type="button"
          className="focus-btn"
          onClick={() => void window.amo?.openInWorkbench?.({ ...(session.taskId ? { taskId: session.taskId } : {}), sessionId: session.id })}
        >
          在工作台打开
        </button>
      </div>
    </div>
  );
}
