import { useState } from "react";
import type { QuestionReply } from "@amo-studio/protocol";
import { call, type HostLink } from "../../host/client.js";
import { Markdown } from "../../lib/markdown.js";
import { IconChevronDown, IconChevronRight, IconEdit, IconPlan } from "../icons.js";
import { isLongPlan, planTitle, type QuestionItem } from "./flow.js";

// Claude's plan review (ExitPlanMode, session permission 只做计划), after DSH's plan-review card (ui-user-questions,
// MIT): the plan itself stays in the conversation as a card (Markdown, folded when long); the decision sits above
// the composer — "批准并开始" leaves plan mode, "要修改" sends what is typed in the composer back as feedback.

const PLAN_STATE: Record<QuestionItem["state"], string> = { pending: "待你审阅", answered: "已批准", dismissed: "已关闭，未批准", cancelled: "已取消" };

/** The plan in the conversation. */
export function PlanCard({ item }: { item: QuestionItem }) {
  const plan = item.plan ?? "";
  const long = isLongPlan(plan);
  const [open, setOpen] = useState(!long);
  const state = item.state === "answered" && item.feedback ? "已要求修改" : PLAN_STATE[item.state];
  return (
    <div className="plan-card" data-testid="plan-card" data-state={item.state} data-revised={item.feedback ? "" : undefined}>
      <div className="plan-card-head">
        <IconPlan />
        <span className="plan-card-title">Claude 的计划</span>
        <span className={`plan-card-state ${item.state}`}>{state}</span>
      </div>
      {plan ? (
        <div className={`plan-card-body${open ? "" : " folded"}`}>
          <Markdown source={plan} />
        </div>
      ) : (
        <div className="plan-card-empty">Claude 没有给出计划正文。</div>
      )}
      {long && (
        <button type="button" className="plan-card-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <IconChevronDown /> : <IconChevronRight />}
          {open ? "收起计划" : "展开全部计划"}
        </button>
      )}
      {item.feedback && (
        <div className="plan-card-feedback">
          <span className="plan-card-feedback-label">修改意见</span>
          <span className="plan-card-feedback-text">{item.feedback}</span>
        </div>
      )}
    </div>
  );
}

interface BarProps {
  link: HostLink;
  sessionId: string;
  item: QuestionItem;
  /** The composer is collecting the feedback. */
  revising: boolean;
  /** "要修改": with text already in the composer it goes at once; otherwise the composer takes it. */
  onRevise(): void;
  onCancelRevise(): void;
}

/** The decision above the composer while a plan waits for review. */
export function PlanReviewBar({ link, sessionId, item, revising, onRevise, onCancelRevise }: BarProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: QuestionReply) => {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/sessions/:id/questions/:itemId/answer", { id: sessionId, itemId: item.id }, body);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="plan-bar" data-testid="plan-review-bar" role="group" aria-label="计划审阅">
      <span className="plan-bar-dot" aria-hidden="true" />
      <span className="plan-bar-text">
        {revising ? "在下面写下要修改的地方，回车发给 Claude" : <>计划待审：{planTitle(item.plan ?? "")}</>}
      </span>
      <span className="plan-bar-error" role="status">
        {error}
      </span>
      {revising ? (
        <button type="button" className="btn-ghost small" disabled={busy} onClick={onCancelRevise}>
          取消修改
        </button>
      ) : (
        <>
          <button type="button" className="btn-ghost small dim" disabled={busy} title="不批准，留在只做计划" onClick={() => void send({ action: "dismiss" })}>
            先不批准
          </button>
          <button type="button" className="btn-ghost small" disabled={busy} onClick={onRevise}>
            <IconEdit /> 要修改
          </button>
          <button type="button" className="btn-primary small" disabled={busy} title="批准计划，会话的权限从“只做计划”换成“每次询问”" onClick={() => void send({ action: "approve" })}>
            {busy ? "处理中…" : "批准并开始"}
          </button>
        </>
      )}
    </div>
  );
}

/** Sends the composer's text as the plan's revision; resolves to an error message, or null. */
export async function sendRevision(link: HostLink, sessionId: string, itemId: string, feedback: string): Promise<string | null> {
  try {
    await call(link, "POST /api/sessions/:id/questions/:itemId/answer", { id: sessionId, itemId }, { action: "revise", feedback });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
