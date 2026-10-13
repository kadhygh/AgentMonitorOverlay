import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { Annotation, ApprovalDecision, ModelProfile, Session, SessionItem, SessionPreset, Task } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { SessionOptionsBar } from "../chat/SessionOptionsBar.js";
import { readSelection, type SelectionAnchor } from "../lib/selection.js";
import { copyText } from "../host/client.js";
import { ReplyNav } from "./ReplyNav.js";
import { Transcript } from "../chat/Transcript.js";
import { useTranscriptView } from "../chat/prefs.js";
import { IconArrowDown, IconArrowUp, IconStop } from "../chat/icons.js";
import { formatTokens, sessionStats, type ApprovalItem } from "../chat/turns.js";
import { useAttachments } from "../attach/useAttachments.js";
import { AttachTray } from "../attach/AttachTray.js";
import { AttachLink } from "../attach/MessageAttachments.js";
import { IconPaperclip } from "../attach/icons.js";
import { withFileRefs } from "../attach/refs.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import { FileSelector } from "../attach/FileSelector.js";
import { markFileMessage } from "../marks/open.js";
import { QuestionCard } from "../chat/questions/QuestionCard.js";
import { PlanReviewBar, sendRevision } from "../chat/questions/PlanReview.js";
import { QuestionSeatContext } from "../chat/questions/QuestionRecord.js";
import { pendingQuestion } from "../chat/questions/flow.js";

interface ThreadProps {
  link: HostLink;
  session: Session | null;
  /** The session's model profile (its account mark and models). */
  profile?: ModelProfile;
  /** Tasks the composer can @ (the message then says which AMO tasks they are). */
  tasks?: readonly Task[];
  /** Sessions the composer can @ (those of the same project or topic are offered). */
  sessions?: readonly Session[];
  /** 常用预设, shown as chips for sessions on the same profile. */
  presets: readonly SessionPreset[];
  items: readonly SessionItem[];
  /** Unsent annotations are highlighted in the replies they point at. */
  annotations: readonly Annotation[];
  model: string;
  busy: boolean;
  onApprove(item: ApprovalItem, decision: ApprovalDecision): void;
  onJump(sessionId: string): void;
  /** `attachments`: ids of uploaded images sent along. */
  onSend(text: string, attachments: string[]): Promise<boolean>;
  onInterrupt(): void;
  /** "添加批注" from the selection menu. */
  onAnnotate(anchor: SelectionAnchor): void;
}

type Menu = { x: number; y: number; anchor: SelectionAnchor } | null;

/** Conversation of one session plus its composer. */
export function Thread({ link, presets, session, profile, tasks = [], sessions = [], items, annotations, model, busy, onApprove, onJump, onSend, onInterrupt, onAnnotate }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const view = useTranscriptView();
  useEffect(() => setDraft(""), [session?.id]);
  const attach = useAttachments(link);
  // 找文件: the selector, opened with Ctrl+P or from the @ list (with what was typed after @).
  const [finding, setFinding] = useState<{ query: string } | null>(null);
  const mentions = useComposerMentions({
    link,
    text: draft,
    setText: setDraft,
    tasks,
    sessions,
    current: session,
    onFile: (path) => attach.addFiles([path]),
    onFind: (query) => setFinding({ query }),
    onMark: (ref) => attach.addRefs([ref]),
  });
  const resetAttach = attach.reset;
  useEffect(() => resetAttach(), [session?.id, resetAttach]);
  useEffect(() => setFinding(null), [session?.id]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // A question the agent waits on takes the composer's seat (a plan review sits above the composer instead). Its card
  // can be closed and opened again from its row in the conversation; "要修改" turns the composer into the feedback box.
  const asked = useMemo(() => pendingQuestion(items), [items]);
  const [hiddenCards, setHiddenCards] = useState<ReadonlySet<string>>(new Set());
  const [revising, setRevising] = useState<string | null>(null);
  useEffect(() => {
    setHiddenCards(new Set());
    setRevising(null);
  }, [session?.id]);
  const planReview = asked?.source === "plan-review" ? asked : null;
  const isRevising = !!planReview && revising === planReview.id;
  const seat = useMemo(
    () => ({
      isOpen: (id: string) => asked?.id === id && asked.source !== "plan-review" && !hiddenCards.has(id),
      reopen: (id: string) =>
        setHiddenCards((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        }),
    }),
    [asked, hiddenCards],
  );

  // The selection menu closes on Escape, on any click outside it, and when the thread scrolls.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".ctx-menu") && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  const sources = new Map(items.filter((i) => i.type === "agent").map((i) => [i.id, (i as { markdown: string }).markdown]));
  const quoteToDraft = (quote: string) =>
    setDraft((d) => `${d.trim() ? `${d.trimEnd()}\n\n` : ""}${quote.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);

  // Keep following the bottom while new output arrives, unless the person scrolled up to read. Content also grows
  // without new items (a group opening, a running command's output), so watch its size as well.
  const toBottom = () => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toBottom, [items, session?.status]);
  useEffect(() => {
    const el = scroller.current?.firstElementChild;
    if (!el) return;
    const ro = new ResizeObserver(toBottom);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session?.id]);
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [session?.id]);

  // A Claude subagent has no conversation of its own; it is followed from its parent session.
  const claudeSub = session?.runtime === "claude" && session.kind === "sub";
  const readOnly = !session || claudeSub || session.writer === "archived" || session.writer === "terminal-handoff";
  const generating = !!session && (session.status === "running" || session.status === "awaiting-approval" || session.status === "awaiting-answer");
  // Codex steers the running turn at once; Claude reads it after the next tool call, or as the next turn.
  const queues = session?.runtime === "claude";
  const placeholder = readOnly
    ? claudeSub
      ? "Claude 的子 agent 不能单独接收消息，请在父会话里继续。"
      : session?.writer === "archived"
        ? "已归档的会话只能查看，恢复后才能继续。"
        : "会话已交给终端，工作台暂时只读。"
    : isRevising
      ? "写下要修改的地方，回车发给 Claude（计划会按你的意见重写）"
      : planReview
      ? "计划在等你审阅：可以先在这里写下意见，再点上面的「要修改」"
      : generating
      ? queues
        ? "回复生成中，发出的内容会在下一次工具调用后或本轮结束后被读到"
        : "回复生成中，输入的内容会作为插话发出"
      : "继续推进这个会话，回车发送，Shift+回车换行";
  const stats = useMemo(() => sessionStats(items), [items]);
  const sendLabel = generating ? (queues ? "排队" : "插话") : "发送";
  // Images must finish uploading (or be removed when they failed) before the message can go.
  const attachHold = attach.uploading ? "图片上传中…" : attach.failed ? "有图片上传失败，移除后再发送" : "";
  const canSend = !readOnly && !attachHold && (!!draft.trim() || (!attach.empty && !isRevising));

  /** "要修改": text already typed goes at once; otherwise the composer collects it. */
  async function revise(feedback: string): Promise<boolean> {
    if (!session || !planReview) return false;
    const failed = await sendRevision(link, session.id, planReview.id, feedback);
    if (failed) return false;
    setRevising(null);
    return true;
  }

  async function send() {
    const text = draft.trim();
    if (!canSend) return;
    if (isRevising) {
      setDraft("");
      if (!(await revise(text))) setDraft((d) => (d.trim() ? d : text));
      return;
    }
    // Clear at once so the next message can be typed while this one is on its way; put it back if sending failed
    // (and nothing new was typed meanwhile). Clearing after the request would wipe what was typed in between.
    setDraft("");
    const sent = attach.take();
    stick.current = true;
    setAtBottom(true);
    const message = withFileRefs(text ? mentions.expand(text) : "", sent.refs);
    const ids = sent.images.flatMap((i) => (i.id ? [i.id] : []));
    if (await onSend(message, ids)) attach.release(sent);
    else {
      setDraft((d) => (d.trim() ? d : text));
      attach.restore(sent);
    }
  }

  // Ctrl+P anywhere on the session's page opens the file selector (not while another dialog holds the keys).
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "p") return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setFinding({ query: "" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  // Files dragged in from Explorer (or anywhere) over the conversation or the composer.
  const dropTarget = readOnly
    ? {}
    : {
        onDragOver: (e: DragEvent) => {
          if (attach.onDragOver(e)) setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          setDragging(false);
          attach.onDrop(e);
        },
      };

  return (
    <>
      <div className="thread-wrap" data-dragging={dragging || undefined} {...dropTarget}>
        <ReplyNav scroller={scroller} itemCount={items.length} />
        <div
          className="thread"
          data-testid="thread"
          data-view={view}
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            stick.current = bottom;
            setAtBottom(bottom);
            if (menu) setMenu(null);
          }}
          onContextMenu={(e) => {
            const anchor = readSelection(sources);
            if (!anchor) return setMenu(null);
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, anchor });
          }}
        >
          <div className="thread-inner">
            {!session && <div className="thread-empty">这个任务还没有会话。在左侧新建一个会话即可开始。</div>}
            <AttachLink.Provider value={link}>
              <QuestionSeatContext.Provider value={seat}>
                <Transcript session={session} items={items} annotations={annotations} model={model} busy={busy} view={view} onApprove={onApprove} onJump={onJump} />
              </QuestionSeatContext.Provider>
            </AttachLink.Provider>
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            className="to-bottom"
            aria-label="回到底部"
            title="回到底部"
            onClick={() => {
              const el = scroller.current;
              if (!el) return;
              stick.current = true;
              setAtBottom(true);
              el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
          >
            <IconArrowDown />
          </button>
        )}
      </div>
      {menu && (
        <div className="ctx-menu" role="menu" aria-label="选中文字" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAnnotate(menu.anchor);
              setMenu(null);
            }}
          >
            添加批注
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!session || session.writer === "archived" || session.writer === "terminal-handoff"}
            onClick={() => {
              quoteToDraft(menu.anchor.quote);
              setMenu(null);
            }}
          >
            引用到输入框
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void copyText(menu.anchor.quote);
              setMenu(null);
            }}
          >
            复制
          </button>
        </div>
      )}
      {session && asked && !readOnly && seat.isOpen(asked.id) && (
        <div className="composer-dock">
          <QuestionCard link={link} sessionId={session.id} item={asked} onClose={() => setHiddenCards((cur) => new Set(cur).add(asked.id))} />
        </div>
      )}
      {session && !(asked && !readOnly && seat.isOpen(asked.id)) && (
        <div className="composer-dock" {...dropTarget}>
          {planReview && !readOnly && (
            <PlanReviewBar
              link={link}
              sessionId={session.id}
              item={planReview}
              revising={isRevising}
              onRevise={() => {
                const text = draft.trim();
                if (text) {
                  setDraft("");
                  void revise(text).then((ok) => !ok && setDraft((d) => (d.trim() ? d : text)));
                  return;
                }
                setRevising(planReview.id);
                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat-input textarea")?.focus());
              }}
              onCancelRevise={() => setRevising(null)}
            />
          )}
          <div className={`composer-card${readOnly ? " disabled" : ""}${dragging ? " dropping" : ""}`}>
            <AttachTray attach={attach} disabled={readOnly} />
            <label className="chat-input">
              <span className="sr-only">输入消息</span>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  mentions.track(e.target);
                }}
                onSelect={(e) => mentions.track(e.currentTarget)}
                onPaste={readOnly ? undefined : attach.onPaste}
                disabled={readOnly}
                rows={2}
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (mentions.onKeyDown(e)) return;
                  if (isRevising && e.key === "Escape") {
                    e.preventDefault();
                    setRevising(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </label>
            <MentionList mentions={mentions} />
            <div className="chat-bar">
              <button
                type="button"
                className="round-btn attach"
                aria-label="添加图片或文件"
                title="添加图片或文件（也可以粘贴或拖进来）"
                disabled={readOnly}
                onClick={() => picker.current?.click()}
              >
                <IconPaperclip />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="attach-input"
                onChange={(e) => {
                  attach.addDropped([...(e.currentTarget.files ?? [])]);
                  e.currentTarget.value = "";
                }}
              />
              <SessionOptionsBar link={link} session={session} profile={profile} presets={presets} disabled={readOnly} />
              <span className="composer-hint">{attachHold || (generating && !readOnly && !planReview ? (queues ? "生成中：工具调用后或本轮结束后读到" : "生成中：发送会插入到当前回合") : "")}</span>
              <span className="spacer" />
              {generating && !readOnly && (
                <button type="button" className="round-btn stop" onClick={onInterrupt} aria-label="打断" title="停止生成">
                  <IconStop />
                </button>
              )}
              <button
                type="button"
                className="round-btn send"
                onClick={() => void send()}
                disabled={!canSend}
                aria-label={isRevising ? "发送修改意见" : sendLabel}
                title={isRevising ? "把修改意见发给 Claude" : generating ? (queues ? "排队发送" : "插话发送") : "发送消息"}
              >
                <IconArrowUp />
              </button>
            </div>
          </div>
          {stats.turns > 0 && (
            <div className="composer-stats" data-testid="composer-stats">
              <span>
                {stats.turns} 轮 {stats.steps} 步
              </span>
              {stats.tokens > 0 && <span>用量 {formatTokens(stats.tokens)}</span>}
              {stats.cacheHit !== null && <span>缓存命中 {stats.cacheHit}%</span>}
              {stats.context && (
                <span
                  className={`context-use${stats.context.percent !== null && stats.context.percent >= 80 ? " high" : ""}`}
                  title="当前上下文 / 模型最大上下文（最近一轮结束时）"
                  data-testid="context-use"
                >
                  上下文 {formatTokens(stats.context.used)}
                  {stats.context.window ? ` / ${formatTokens(stats.context.window)} · ${stats.context.percent}%` : ""}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {finding && session && (
        <FileSelector
          link={link}
          workspaceId={session.workspaceId}
          initialQuery={finding.query}
          onPick={(path) => attach.addFiles([path])}
          onMark={(path) => markFileMessage(link, path)}
          onClose={() => {
            setFinding(null);
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat-input textarea")?.focus());
          }}
        />
      )}
    </>
  );
}
