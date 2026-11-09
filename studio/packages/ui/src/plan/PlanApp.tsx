import { useEffect, useMemo, useRef, useState } from "react";
import { composeAnnotationRefs, splitAnnotationRefs, type Annotation, type QuestionReply } from "@amo-studio/protocol";
import { useHostState } from "../host/useHostState.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { Markdown } from "../lib/markdown.js";
import { readSelection, type SelectionAnchor } from "../lib/selection.js";
import { showToast } from "../lib/toast.js";
import { useAnnotations } from "../review/useAnnotations.js";
import { AnnotationBubble, contentRect, SelectionBar, type BubbleTarget, type ContentRect } from "../review/AnnotationBubble.js";
import { annotationAt, annotationRect, flashAnnotation, highlightsSupported, useAnnotationHighlights } from "../review/highlights.js";
import { TitleMark, WindowControls, WindowPlaceholder } from "../shell/WindowControls.js";
import { planTitle, type QuestionItem } from "../chat/questions/flow.js";
import { latestPlan, planVersions, readPlanDraft, shownPlan, writePlanDraft } from "./plans.js";
import "./plan.css";

// 计划窗口 (2026-11-09, the user: Claude 的计划在聊天里是一大章文字，不能批注，回复还要回到聊天输入框，很奇怪；计划应该有自己的
// 输入框，开启关闭后输入内容要能保留 — plans/done/plan-review-window.md). The plan Claude asks to have reviewed, in a window of its
// own: select words to annotate them (the session's annotations, as on replies), write what to change in its own box,
// and send both with 要修改 — or approve, or put it aside. The box's text is kept per version until it is sent.

const hashParams = () => new URLSearchParams(location.hash.split("?")[1] ?? "");

const PLAN_STATE: Record<QuestionItem["state"], string> = { pending: "待你审阅", answered: "已批准", dismissed: "已关闭，未批准", cancelled: "已取消" };

export function PlanApp() {
  const host = useHostState();
  const [asked, setAsked] = useState(() => ({ session: hashParams().get("session"), item: hashParams().get("item") }));
  useEffect(() => {
    const onHash = () => setAsked({ session: hashParams().get("session"), item: hashParams().get("item") });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (host.kind !== "ready")
    return <WindowPlaceholder title="计划">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</WindowPlaceholder>;
  if (!asked.session) return <WindowPlaceholder title="计划">没有指定会话。</WindowPlaceholder>;
  const session = host.state.sessions.find((s) => s.id === asked.session);
  return <PlanWindow key={asked.session} link={host.link} sessionId={asked.session} sessionTitle={session?.title ?? ""} askedItem={asked.item} />;
}

function PlanWindow({ link, sessionId, sessionTitle, askedItem }: { link: HostLink; sessionId: string; sessionTitle: string; askedItem: string | null }) {
  const { items } = useSessionItems(link, sessionId);
  const versions = useMemo(() => planVersions(items), [items]);
  const annotations = useAnnotations(link, sessionId);
  // The version shown: the one asked for; when Claude presents a new one to review, that one.
  const [picked, setPicked] = useState<string | null>(askedItem);
  useEffect(() => setPicked(askedItem), [askedItem]);
  const plan = shownPlan(versions, picked);
  const latest = latestPlan(versions);
  const waiting = latest?.state === "pending" ? latest.id : null;
  // The one waiting when the window read the session is left alone (an older version may have been asked for).
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!versions.length) return;
    if (seen.current !== undefined && waiting && waiting !== seen.current) setPicked(waiting);
    seen.current = waiting;
  }, [versions.length, waiting]);
  const number = plan ? versions.findIndex((v) => v.id === plan.id) + 1 : 0;
  const title = plan ? planTitle(plan.plan ?? "") : "";
  useEffect(() => {
    document.title = title ? `计划 · ${title}` : "计划";
  }, [title]);

  return (
    <div className="plan-win" data-testid="plan-window">
      <div className="plan-win-bar titlebar">
        <TitleMark />
        <span className="plan-win-title">{title || "计划"}</span>
        {sessionTitle && <span className="plan-win-session">{sessionTitle}</span>}
        {versions.length > 1 && (
          <select aria-label="版本" value={plan?.id ?? ""} onChange={(e) => setPicked(e.target.value)} data-testid="plan-version">
            {versions.map((v, i) => (
              <option key={v.id} value={v.id}>
                第 {i + 1} 版{v.state === "pending" ? "（待审）" : ""}
              </option>
            ))}
          </select>
        )}
        {plan && (
          <span className={`plan-card-state ${plan.state}`} data-testid="plan-window-state">
            {plan.state === "answered" && plan.feedback ? "已要求修改" : PLAN_STATE[plan.state]}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => void window.amo?.openInWorkbench?.({ sessionId, show: true })} title="在工作台打开这个会话">
          回到会话
        </button>
        <WindowControls pin />
      </div>
      {!plan ? (
        <div className="plan-win-empty">{versions.length ? "找不到这一版计划。" : "这个会话还没有计划。"}</div>
      ) : (
        <PlanReview key={plan.id} link={link} sessionId={sessionId} plan={plan} number={number} annotations={annotations.filter((a) => a.itemId === plan.id)} />
      )}
    </div>
  );
}

function PlanReview({ link, sessionId, plan, number, annotations }: { link: HostLink; sessionId: string; plan: QuestionItem; number: number; annotations: readonly Annotation[] }) {
  const text = plan.plan ?? "";
  const pending = plan.state === "pending";
  const unsent = annotations.filter((a) => !a.sentAt);
  const scroller = useRef<HTMLDivElement>(null);
  const sources = useMemo(() => new Map([[plan.id, text]]), [plan.id, text]);
  useAnnotationHighlights(scroller, pending ? unsent : [], sources);

  const [draft, setDraft] = useState(() => readPlanDraft(plan.id));
  useEffect(() => writePlanDraft(plan.id, draft), [plan.id, draft]);
  const [busy, setBusy] = useState(false);
  const [bar, setBar] = useState<{ anchor: SelectionAnchor; at: ContentRect } | null>(null);
  const [bubble, setBubble] = useState<BubbleTarget | null>(null);
  const inBubble = (t: EventTarget | null) => t instanceof Element && !!t.closest(".anno-bubble, .sel-bar");
  const selectionRect = (): ContentRect | null => {
    const sel = window.getSelection();
    const el = scroller.current;
    if (!el || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? contentRect(el, r) : null;
  };

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return null;
    } finally {
      setBusy(false);
    }
  }
  const answer = (body: QuestionReply) => run(() => call(link, "POST /api/sessions/:id/questions/:itemId/answer", { id: sessionId, itemId: plan.id }, body));
  const revise = async () => {
    if (!draft.trim() && !unsent.length) return showToast({ text: "先写下要修改的地方，或在计划里选中文字写批注", error: true });
    const done = await answer({ action: "revise", feedback: draft.trim(), annotations: unsent.map((a) => a.id) });
    if (done) setDraft("");
  };
  const copy = () => {
    const refs = unsent.map((a) => ({ n: a.n ?? 0, quote: a.quote, note: a.note }));
    void copyText(composeAnnotationRefs(draft, refs));
    showToast("已复制修改意见和批注");
  };
  const feedback = plan.feedback ? splitAnnotationRefs(plan.feedback) : null;

  return (
    <>
      <div
        className="plan-win-body"
        ref={scroller}
        onMouseDown={(e) => {
          if (!inBubble(e.target)) setBar(null);
        }}
        onMouseUp={(e) => {
          if (!pending || inBubble(e.target) || e.button !== 0) return;
          requestAnimationFrame(() => {
            const anchor = readSelection(sources);
            const at = anchor && selectionRect();
            setBar(anchor && at && !bubble ? { anchor, at } : null);
          });
        }}
        onMouseMove={(e) => {
          if (!highlightsSupported()) return;
          e.currentTarget.style.cursor = !inBubble(e.target) && annotationAt(e.clientX, e.clientY) !== null ? "pointer" : "";
        }}
        onClick={(e) => {
          // A highlighted passage opens its note.
          if (!pending || inBubble(e.target) || !window.getSelection()?.isCollapsed || !highlightsSupported()) return;
          const id = annotationAt(e.clientX, e.clientY);
          const annotation = id ? unsent.find((a) => a.id === id) : undefined;
          const rect = id ? annotationRect(id) : null;
          if (annotation && rect && scroller.current) setBubble({ kind: "edit", annotation, at: contentRect(scroller.current, rect) });
        }}
      >
        <div className="plan-win-doc" data-item-id={plan.id} data-item-type="agent" data-testid="plan-window-doc">
          {text ? <Markdown source={text} highlights={pending ? unsent : []} /> : <div className="plan-card-empty">Claude 没有给出计划正文。</div>}
        </div>
        {bar && !bubble && (
          <SelectionBar
            scroller={scroller}
            at={bar.at}
            canQuote={false}
            onAnnotate={() => {
              setBubble({ kind: "new", anchor: bar.anchor, at: bar.at });
              setBar(null);
            }}
            onQuote={() => undefined}
            onCopy={() => void copyText(bar.anchor.quote)}
          />
        )}
        {bubble && (
          <AnnotationBubble
            key={bubble.kind === "edit" ? bubble.annotation.id : `${bubble.anchor.itemId}:${bubble.anchor.start}`}
            scroller={scroller}
            target={bubble}
            onSave={async (note) =>
              (await run(() =>
                bubble.kind === "edit" ? call(link, "PATCH /api/annotations/:id", { id: bubble.annotation.id }, { note }) : call(link, "POST /api/sessions/:id/annotations", { id: sessionId }, { ...bubble.anchor, note }),
              )) !== null
            }
            {...(bubble.kind === "edit"
              ? {
                  onDelete: () => {
                    void run(() => call(link, "DELETE /api/annotations/:id", { id: bubble.annotation.id }));
                    setBubble(null);
                  },
                }
              : {})}
            onClose={() => {
              setBubble(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}
      </div>
      {pending ? (
        <div className="plan-win-review" data-testid="plan-window-review">
          {unsent.length > 0 && (
            <div className="plan-win-notes" data-testid="plan-window-notes">
              {unsent.map((a) => (
                <div key={a.id} className="plan-win-note">
                  <button type="button" className="plan-win-note-n" onClick={() => flashAnnotation(a.id)} title="在计划里找到这段">
                    批注{a.n ?? ""}
                  </button>
                  <span className="plan-win-note-quote" title={a.quote}>
                    {a.quote}
                  </span>
                  <span className="plan-win-note-text">{a.note}</span>
                  <button type="button" className="icon-btn" aria-label="删除这条批注" disabled={busy} onClick={() => void run(() => call(link, "DELETE /api/annotations/:id", { id: a.id }))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="field plan-win-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void revise();
              }
            }}
            placeholder={`要修改的地方（第 ${number} 版）。也可以在上面选中文字写批注，和这里的话一起发给 Claude。Ctrl+Enter 发送`}
            aria-label="要修改的地方"
            data-testid="plan-window-input"
          />
          <div className="plan-win-actions">
            <button type="button" className="btn-ghost small" disabled={!draft.trim() && !unsent.length} onClick={copy} title="把输入框里的话和批注复制下来" data-testid="plan-window-copy">
              复制批注
            </button>
            <span className="spacer" />
            <button type="button" className="btn-ghost small dim" disabled={busy} title="不批准，留在只做计划" onClick={() => void answer({ action: "dismiss" })}>
              先不批准
            </button>
            <button type="button" className="btn-ghost small" disabled={busy || (!draft.trim() && !unsent.length)} onClick={() => void revise()} data-testid="plan-window-revise">
              要修改{unsent.length ? `（${unsent.length} 条批注）` : ""}
            </button>
            <button type="button" className="btn-primary small" disabled={busy} title="批准计划，会话的权限从“只做计划”换成“每次询问”" onClick={() => void answer({ action: "approve" })} data-testid="plan-window-approve">
              批准并开始
            </button>
          </div>
        </div>
      ) : (
        feedback && (
          <div className="plan-win-review done" data-testid="plan-window-feedback">
            <span className="plan-card-feedback-label">发给 Claude 的修改意见</span>
            {feedback.text.trim() && <span className="plan-card-feedback-text">{feedback.text.trim()}</span>}
            {feedback.refs.map((r) => (
              <div key={r.n} className="plan-win-note">
                <span className="plan-win-note-n">批注{r.n}</span>
                <span className="plan-win-note-quote" title={r.quote}>
                  {r.quote}
                </span>
                <span className="plan-win-note-text">{r.note}</span>
              </div>
            ))}
          </div>
        )
      )}
    </>
  );
}
