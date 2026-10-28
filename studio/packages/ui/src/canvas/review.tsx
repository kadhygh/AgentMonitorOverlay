import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CALLOUT_DETAIL_MAX, ITEM_CARD, REVIEW_STATUSES, type CanvasCallout, type CanvasItem, type Id, type ReviewStatus, type Session } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Markdown } from "../lib/markdown.js";
import { DeleteButton } from "./DeleteButton.js";
import { relativeTime, SESSION_LOOK } from "../lib/status.js";

// 画布审阅 (2026-10-27, plans/review-canvas.md): a review's items as cards, the agents' remarks and questions pinned to
// cards as bubbles, the window a question is answered in, and the sidebar's 沟通 list.

export const statusLabel = (s: ReviewStatus) => REVIEW_STATUSES.find((x) => x.id === s)?.label ?? s;
/** A mark beside each status word, so it never rests on colour alone. */
const STATUS_MARK: Record<ReviewStatus, string> = { todo: "○", confirmed: "✓", discuss: "?", parked: "–", done: "✓" };

/** A session's name cut to fit a line (a first message can be its title). */
const nameOf = (s: Session) => {
  const t = (s.title || "未命名会话").replace(/\s+/g, " ").trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
};

/** A line of plain text from Markdown, for a card. */
const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** What an item's sessions are doing: the one that laid it out handling an answer, or the sessions talking it over. */
export function itemActivity(item: CanvasItem, callouts: readonly CanvasCallout[], sessions: readonly Session[]): { text: string; dot: string; color: string } | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const threads = (item.threads ?? []).map((id) => byId.get(id)).filter((s): s is Session => !!s && !s.archivedAt);
  const waiting = threads.find((s) => s.status === "awaiting-answer" || s.status === "awaiting-approval" || s.status === "awaiting-review");
  if (waiting) return { text: `子对话${SESSION_LOOK[waiting.status].label}`, dot: SESSION_LOOK[waiting.status].dot, color: SESSION_LOOK[waiting.status].text };
  const poster = item.sessionId ? byId.get(item.sessionId) : undefined;
  if (poster?.status === "running" && callouts.some((c) => c.target === item.id && c.state === "answered")) return { text: "◐ 进行中 · 在处理你的回答", dot: SESSION_LOOK.running.dot, color: SESSION_LOOK.running.text };
  if (threads.some((s) => s.status === "running")) return { text: "◐ 子对话进行中", dot: SESSION_LOOK.running.dot, color: SESSION_LOOK.running.text };
  if (threads.length) return { text: `${threads.length} 个子对话`, dot: "var(--muted-dot)", color: "var(--text-dim)" };
  return null;
}

/** Which kind of bubble a card is highlighted with: an open question first, then an open remark. */
export function calloutFlags(callouts: readonly CanvasCallout[]): ReadonlyMap<Id, "question" | "note"> {
  const flags = new Map<Id, "question" | "note">();
  for (const c of callouts) {
    if (c.state !== "open") continue;
    if (c.kind === "question") flags.set(c.target, "question");
    else if (!flags.has(c.target)) flags.set(c.target, "note");
  }
  return flags;
}

export function ItemCard({
  node,
  activity,
  flag,
  selected,
  handles,
  onOpen,
  onMouseDown,
  onContextMenu,
}: {
  node: CanvasItem;
  activity: ReturnType<typeof itemActivity>;
  flag?: "question" | "note";
  selected: boolean;
  handles?: ReactNode;
  onOpen(): void;
  onMouseDown(e: ReactMouseEvent): void;
  onContextMenu(e: ReactMouseEvent): void;
}) {
  const summary = node.conclusion ? `结论：${plain(node.conclusion)}` : node.body ? plain(node.body) : "";
  const size = node.size ?? ITEM_CARD;
  // Dragged to a size (2026-10-29): as many summary lines as fit under the head, the title and the activity line.
  const lines = node.size ? Math.floor((size.h - ITEM_FIXED - (activity ? ITEM_ACTIVITY : 0)) / ITEM_LINE) : null;
  return (
    <div
      className={`canvas-card canvas-item${selected ? " selected" : ""}`}
      style={{ left: node.pos.x, top: node.pos.y, width: size.w, height: size.h }}
      role="button"
      tabIndex={0}
      aria-label={`审阅条目 #${node.num} ${node.title}`}
      data-testid="canvas-item"
      data-node-id={node.id}
      data-group-id={node.groupId ?? ""}
      data-color={node.color}
      data-status={node.status}
      data-callout={flag}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <span className="item-head">
        <span className="item-num">#{node.num}</span>
        <span className="item-status" data-status={node.status} data-testid="item-status">
          {STATUS_MARK[node.status]} {statusLabel(node.status)}
        </span>
      </span>
      <span className="canvas-card-title" title={node.title}>
        {node.title}
      </span>
      {summary && (lines === null || lines > 0) && (
        <span className={node.conclusion ? "item-summary is-conclusion" : "item-summary"} title={summary} style={lines ? { WebkitLineClamp: lines } : undefined}>
          {summary}
        </span>
      )}
      {activity && (
        <span className="canvas-card-meta item-activity" data-testid="item-activity">
          <span className="dot" style={{ background: activity.dot }} />
          <span style={{ color: activity.color }}>{activity.text}</span>
        </span>
      )}
      {handles}
    </div>
  );
}

/** A review item's card around its summary: padding, the head and the title with their gaps; the activity line; a summary line. */
const ITEM_FIXED = 66;
const ITEM_ACTIVITY = 21;
const ITEM_LINE = 17.4;
/** The smallest a review item's card may be dragged to: its head, title and activity still fit. */
export const ITEM_MIN = { w: 160, h: 88 };

/** Bubbles shown on one card before the rest fold into "+N". */
const SHOWN_PER_CARD = 2;
const ORDER = (c: CanvasCallout) => (c.state === "open" ? (c.kind === "question" ? 0 : 1) : 2);

/**
 * The bubbles on the canvas: above each card's top-right corner, open questions first. `anchor` is a card's (or
 * group's) box by the callout's target; a target no longer on the canvas shows only in the sidebar.
 */
export function CalloutLayer({
  callouts,
  sessions,
  anchor,
  onOpen,
  onClose,
  onMore,
}: {
  callouts: readonly CanvasCallout[];
  sessions: readonly Session[];
  anchor(target: Id): { x: number; y: number; w: number; h: number } | null;
  onOpen(c: CanvasCallout): void;
  onClose(c: CanvasCallout): void;
  onMore(): void;
}) {
  const byTarget = new Map<Id, CanvasCallout[]>();
  for (const c of callouts) if (c.state !== "closed") byTarget.set(c.target, [...(byTarget.get(c.target) ?? []), c]);
  const busy = new Set(sessions.filter((s) => s.status === "running").map((s) => s.id));
  return (
    <>
      {[...byTarget].map(([target, list]) => {
        const r = anchor(target);
        if (!r) return null;
        const sorted = [...list].sort((a, b) => ORDER(a) - ORDER(b) || a.createdAt.localeCompare(b.createdAt));
        const shown = sorted.slice(0, SHOWN_PER_CARD);
        return (
          <div key={target} className="callout-stack" style={{ left: r.x + r.w - 28, top: r.y - 6 }} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} data-testid="callout-stack">
            {sorted.length > SHOWN_PER_CARD && (
              <button type="button" className="callout callout-more" onClick={onMore} title="在侧栏「沟通」里看全部">
                +{sorted.length - SHOWN_PER_CARD}
              </button>
            )}
            {[...shown].reverse().map((c) => (
              <Bubble key={c.id} callout={c} working={!!c.sessionId && busy.has(c.sessionId)} onOpen={() => onOpen(c)} onClose={() => onClose(c)} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function Bubble({ callout: c, working, onOpen, onClose }: { callout: CanvasCallout; working: boolean; onOpen(): void; onClose(): void }) {
  if (c.state === "answered") {
    return (
      <span className="callout callout-answered" data-testid="callout-answered" title={`${c.kind === "question" ? "问" : "说明"}：${c.text}\n答：${c.answer?.text ?? ""}`}>
        <button type="button" className="callout-body" onClick={onOpen}>
          {working ? "◐ AI 处理中" : "✓ 已回答"}
        </button>
        <button type="button" className="callout-x" aria-label="收起" title="收起" onClick={onClose}>
          ×
        </button>
      </span>
    );
  }
  if (c.kind === "question") {
    return (
      <button type="button" className="callout callout-question" onClick={onOpen} data-testid="callout-question" title="点开回答">
        <span className="callout-tag">? 待你确认</span>
        <span className="callout-text">{c.text}</span>
      </button>
    );
  }
  return (
    <span className="callout callout-note" data-testid="callout-note">
      <button type="button" className="callout-body" onClick={onOpen} title="点开看全文或回一句">
        <span className="callout-text">{c.text}</span>
      </button>
      <button type="button" className="callout-x" aria-label="收起说明" title="知道了，收起" onClick={onClose}>
        ×
      </button>
    </span>
  );
}

/**
 * The window a bubble opens in: the question (or remark), the agent's detail, answer choices and a text box. Sending
 * gives the answer to the session that asked; the bubble then folds to 「已回答」. A question the agent marked deep
 * offers the conversation first.
 */
export function CalloutDialog({ link, callout: c, where, author, onOpenSession, onClose }: { link: HostLink; callout: CanvasCallout; where: string; author: Session | undefined; onOpenSession?(): void; onClose(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const send = () => text.trim() && void act(() => call(link, "POST /api/callouts/:id/answer", { id: c.id }, { text: text.trim() }));
  const putAway = () => void act(() => call(link, "POST /api/callouts/:id/close", { id: c.id }));
  const question = c.kind === "question";
  const gone = !author || !!author.archivedAt;
  const answered = c.state === "answered" && c.answer;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal callout-dialog" role="dialog" aria-modal="true" aria-label={question ? "画布上的问题" : "画布上的说明"} data-testid="callout-dialog">
        <span className="modal-title">
          {question ? "问题" : "说明"} · {where}
        </span>
        <span className="settings-hint">
          {author ? `来自会话「${nameOf(author)}」` : c.sessionId ? "写它的会话已经不在了" : "人写的"} · {relativeTime(c.createdAt)}
        </span>
        {c.deep && c.state === "open" && (
          <span className="callout-deep" role="note">
            AI 觉得这个问题比较复杂，建议到对话里看它的解释再回答。
          </span>
        )}
        <div className="callout-dialog-text">{c.text}</div>
        {c.detail && (
          <div className="callout-dialog-detail">
            <Markdown source={c.detail} />
          </div>
        )}
        {answered && (
          <div className="callout-dialog-answer" data-testid="callout-dialog-answer">
            <span className="side-subheading">你的回答 · {relativeTime(c.answer!.at)}</span>
            <span>{c.answer!.text}</span>
            <span className="side-note">{c.answer!.sent === "none" ? "会话已不在，回答没有发出去（AI 下次读画布时能看到）" : "已发给会话"}</span>
          </div>
        )}
        {question && !answered && c.options?.length ? (
          <div className="callout-options" role="group" aria-label="可选的回答">
            {c.options.map((o) => (
              <button key={o} type="button" className={text === o ? "btn-ghost small is-picked" : "btn-ghost small"} aria-pressed={text === o} onClick={() => setText(o)}>
                {o}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          className="side-textarea"
          aria-label={question ? "你的回答" : "回一句"}
          placeholder={answered ? "再补充一句（也会发给会话）" : question ? (c.options?.length ? "选一个，或写你的回答" : "写你的回答") : "回一句（会发给写这条说明的会话）；不用回就收起"}
          value={text}
          rows={question && !answered ? 4 : 2}
          maxLength={CALLOUT_DETAIL_MAX}
          autoFocus={!c.deep}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {gone && c.sessionId && <span className="side-note">写它的会话已经不在了：回答只会留在画布上。</span>}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="description-dialog-actions">
          <span className="settings-hint">Ctrl+Enter 发送 · Esc 稍后</span>
          <span className="spacer" />
          {onOpenSession && (
            <button type="button" className={c.deep && c.state === "open" ? "btn-primary" : "btn-ghost"} onClick={onOpenSession} data-testid="callout-open-session">
              去对话里看
            </button>
          )}
          <button type="button" className="btn-ghost" disabled={busy} onClick={putAway} data-testid="callout-close">
            收起
          </button>
          <button type="button" className={c.deep && c.state === "open" ? "btn-ghost" : "btn-primary"} disabled={busy || !text.trim()} onClick={send} data-testid="callout-send">
            {answered ? "补充" : question ? "发送回答" : "回复"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 侧栏「沟通」: how far the review is, then the questions waiting, the remarks, and what was answered lately. A row
 * centres its card (a question opens too).
 */
export function TalkTab({ items, callouts, nameOf, onFocus }: { items: readonly CanvasItem[]; callouts: readonly CanvasCallout[]; nameOf(target: Id): string; onFocus(c: CanvasCallout): void }) {
  const open = callouts.filter((c) => c.state === "open");
  const questions = open.filter((c) => c.kind === "question");
  const notes = open.filter((c) => c.kind === "note");
  const answered = callouts.filter((c) => c.state === "answered");
  const closed = callouts.filter((c) => c.state === "closed");
  const counts = REVIEW_STATUSES.map((s) => [s, items.filter((i) => i.status === s.id).length] as const).filter(([, n]) => n > 0);
  const row = (c: CanvasCallout) => (
    <button key={c.id} type="button" className={`talk-row is-${c.state} kind-${c.kind}`} onClick={() => onFocus(c)} data-testid="talk-row">
      <span className="talk-on">
        {c.state === "answered" ? "✓ " : c.kind === "question" ? "? " : ""}
        {nameOf(c.target)}
      </span>
      <span className="talk-text">{c.text}</span>
      {c.answer && <span className="talk-answer">答：{c.answer.text}</span>}
    </button>
  );
  return (
    <div className="side-section talk-tab" role="group" aria-label="沟通">
      {items.length > 0 && (
        <div className="talk-progress" data-testid="talk-progress">
          <span className="side-subheading">审阅 {items.length} 条</span>
          <span>{counts.map(([s, n]) => `${STATUS_MARK[s.id]} ${s.label} ${n}`).join(" · ")}</span>
        </div>
      )}
      {!callouts.length && <span className="anno-empty">AI 在卡片上写的说明和问题会列在这里。让它用 canvas_items_post 把审阅铺到画布上，用 canvas_callout 在卡片上提问。</span>}
      {questions.length > 0 && <span className="side-subheading">待你确认 {questions.length}</span>}
      {questions.map(row)}
      {notes.length > 0 && <span className="side-subheading">说明 {notes.length}</span>}
      {notes.map(row)}
      {answered.length > 0 && <span className="side-subheading">已回答，等 AI 处理 {answered.length}</span>}
      {answered.map(row)}
      {closed.length > 0 && (
        <details className="talk-closed">
          <summary>已收起 {closed.length}</summary>
          {closed.map(row)}
        </details>
      )}
    </div>
  );
}

/** 详情 of a review item: status buttons, the whole text, its sources, conclusion and the sessions on it. */
export function ItemDetail({
  item,
  sessions,
  callouts,
  activity,
  onStatus,
  onDiscuss,
  onOpenSession,
  onFocus,
  onDelete,
}: {
  item: CanvasItem;
  sessions: readonly Session[];
  callouts: readonly CanvasCallout[];
  activity: ReturnType<typeof itemActivity>;
  onStatus(status: ReviewStatus): void;
  onDiscuss(): void;
  onOpenSession(sessionId: Id): void;
  onFocus(c: CanvasCallout): void;
  onDelete(): void;
}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const poster = item.sessionId ? byId.get(item.sessionId) : undefined;
  const mine = callouts.filter((c) => c.target === item.id && c.state !== "closed");
  return (
    <div className="side-section item-detail" role="group" aria-label="审阅条目">
      <span className="side-heading">
        #{item.num} {item.title}
      </span>
      <div className="item-status-row" role="group" aria-label="状态">
        {REVIEW_STATUSES.map((s) => (
          <button key={s.id} type="button" className="side-tab" aria-pressed={item.status === s.id} onClick={() => item.status !== s.id && onStatus(s.id)} data-testid={`item-status-${s.id}`}>
            {STATUS_MARK[s.id]} {s.label}
          </button>
        ))}
      </div>
      {activity && (
        <span className="side-note" style={{ color: activity.color }}>
          {activity.text}
        </span>
      )}
      {item.conclusion && (
        <div className="item-conclusion">
          <span className="side-subheading">结论</span>
          <Markdown source={item.conclusion} />
        </div>
      )}
      {item.body ? <Markdown source={item.body} /> : <span className="side-note">没有正文。</span>}
      {item.refs?.length ? (
        <div className="item-refs">
          <span className="side-subheading">涉及</span>
          {item.refs.map((r) => (
            <code key={r}>{r}</code>
          ))}
        </div>
      ) : null}
      {mine.length > 0 && (
        <div className="item-callouts">
          <span className="side-subheading">卡片上的说明和问题</span>
          {mine.map((c) => (
            <button key={c.id} type="button" className={`talk-row is-${c.state} kind-${c.kind}`} onClick={() => onFocus(c)}>
              <span className="talk-text">
                {c.state === "answered" ? "✓ " : c.kind === "question" ? "? " : ""}
                {c.text}
              </span>
              {c.answer && <span className="talk-answer">答：{c.answer.text}</span>}
            </button>
          ))}
        </div>
      )}
      <span className="side-subheading">会话</span>
      {poster && (
        <button type="button" className="btn-ghost small" onClick={() => onOpenSession(poster.id)} disabled={!poster.taskId}>
          打开铺这份审阅的会话「{nameOf(poster)}」
        </button>
      )}
      {(item.threads ?? []).map((id) => {
        const s = byId.get(id);
        return (
          <button key={id} type="button" className="btn-ghost small" disabled={!s?.taskId} onClick={() => onOpenSession(id)} data-testid="item-thread">
            子对话「{s ? nameOf(s) : "已不在"}」{s ? ` · ${SESSION_LOOK[s.status].label}` : ""}
          </button>
        );
      })}
      <button type="button" className="btn-primary small" onClick={onDiscuss} data-testid="item-discuss">
        就这条展开聊（新会话）
      </button>
      <span className="side-note">新会话开在铺这份审阅的任务里，先读这一条；聊出结论后它会写回这张卡片，主会话的上下文不会被撑大。</span>
      <DeleteButton onClick={onDelete}>删除这条</DeleteButton>
    </div>
  );
}
