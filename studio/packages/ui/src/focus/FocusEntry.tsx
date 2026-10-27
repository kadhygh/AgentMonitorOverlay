import { useState, type ReactNode } from "react";
import type { Session, SessionItem } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { relativeTime, SESSION_LOOK, type StatusLook } from "../lib/status.js";
import { planTitle } from "../chat/questions/flow.js";
import { noteFocusJump } from "../lib/focusJump.js";

// One session in the Focus list, opened to show its latest content (stage 16 split out of FocusApp.tsx).

type Approval = Extract<SessionItem, { type: "approval" }>;
const SNIPPET_MAX = 300;

/** Items a Focus entry reads: its latest (the Host adds pending questions and approvals from further back). */
const FOCUS_TAIL = 60;

/** Latest content worth showing: the pending approval, else a pending question (answered in the workbench), else the last agent reply. */
export function latestSnippet(items: readonly SessionItem[]): { text: string; approval: Approval | null } {
  const question = items.find((i): i is Extract<SessionItem, { type: "question" }> => i.type === "question" && i.state === "pending");
  if (question && !items.some((i) => i.type === "approval" && i.state === "pending")) {
    const text =
      question.source === "plan-review"
        ? `计划待审：${planTitle(question.plan ?? "")}`
        : question.source === "mcp-form"
          ? `等你填写：${question.message ?? ""}`
          : (question.questions ?? []).map((q) => q.question).join("\n");
    return { text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text, approval: null };
  }
  const approval = [...items].reverse().find((i): i is Approval => i.type === "approval" && i.state === "pending") ?? null;
  if (approval) return { text: [approval.summary, approval.detail].filter(Boolean).join("\n"), approval };
  const reply = [...items].reverse().find((i) => i.type === "agent");
  const text = reply && reply.type === "agent" ? reply.markdown.trim() : "";
  return { text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text, approval: null };
}

/** Placeholder while the Host connects (the decision hook runs before the link exists). */

/** Finished work to look at: a reply that ended unseen, or a session waiting for review. */
export const TO_REVIEW: StatusLook = { label: "完成待审核", dot: "var(--running)", text: "var(--running-text)" };

/** 完成待审核 rather than a 事: a reply that ended (not failed, not cut off) unseen, or a session waiting for review. */
export function isToReview(s: Session, waiting: readonly Session[]): boolean {
  return s.status === "awaiting-review" || (!waiting.includes(s) && s.status !== "error" && s.status !== "interrupted");
}

/** The robot's words: how many 事 and how many 完成待审核. */
export function summary(things: number, toReview: number): string {
  return [things ? `${things} 件事` : "", toReview ? `${toReview} 个完成待审核` : ""].filter(Boolean).join(" · ") || "没有待处理";
}

export function FocusEntry({
  link,
  session,
  title,
  open,
  finished,
  toReview,
  onToggle,
  onDone,
  pin,
  cut = 0,
}: {
  link: HostLink;
  session: Session;
  title: string;
  open: boolean;
  finished: boolean;
  toReview: boolean;
  onToggle(): void;
  /** 我知道了: a 完成待审核 entry counts as reviewed (seen) and leaves the list. */
  onDone(): void;
  /** 置顶 (2026-10-21): the task's pin, shown on hover. */
  pin?: ReactNode;
  /** Its subagents cut off since the person last looked (2026-10-28): said in red. */
  cut?: number;
}) {
  const look = toReview ? TO_REVIEW : SESSION_LOOK[session.status];
  return (
    <div className={open ? "focus-entry open" : "focus-entry"} data-testid="focus-entry" data-finished={finished || undefined} data-review={toReview || undefined} data-interrupted={session.status === "interrupted" || cut > 0 || undefined}>
      <div className="focus-row-line">
        <button type="button" className="focus-row" onClick={onToggle} aria-expanded={open}>
          <span className="dot" style={{ background: look.dot }} />
          <span className="focus-row-text">
            <span className="focus-title">{title}</span>
            <span className="focus-sub" style={{ color: look.text }}>
              {look.label}
              {cut > 0 && (
                <b className="focus-cut" data-testid="focus-cut">
                  {" · "}
                  {cut} 个子会话被中断
                </b>
              )}
              {session.title ? ` · ${session.title}` : ""}
            </span>
          </span>
          <span className="focus-time">{relativeTime(session.updatedAt)}</span>
        </button>
        {pin}
      </div>
      {open && <FocusDetail link={link} session={session} {...(toReview && finished ? { onDone } : {})} />}
    </div>
  );
}

/** The session's latest content and what can be done about it; `children` adds actions (取消置顶). */
export function FocusDetail({ link, session, onDone, children }: { link: HostLink; session: Session; onDone?(): void; children?: ReactNode }) {
  // Its latest only: what is pending sits at the end (a long session's whole log was 10 MB, 2026-10-24).
  const { items } = useSessionItems(link, session.id, FOCUS_TAIL);
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
          onClick={() => {
            noteFocusJump(session.id);
            void window.amo?.openInWorkbench?.({ ...(session.taskId ? { taskId: session.taskId } : {}), sessionId: session.id });
          }}
        >
          在工作台打开
        </button>
        {onDone && (
          <button type="button" className="focus-btn" title="不用切回来看：算作审核完成，从 Focus 里移走" data-testid="focus-done" onClick={onDone}>
            我知道了
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
