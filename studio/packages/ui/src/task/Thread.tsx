import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type RefObject, type SetStateAction } from "react";
import { readSessionDraft, writeSessionDraft } from "./sessionDraft.js";
import type { Annotation, ApprovalDecision, DecisionRequest, ModelProfile, Session, SessionItem, SessionPreset, SlashCommand, Task } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { SessionOptionsBar } from "../chat/SessionOptionsBar.js";
import { readSelection, type SelectionAnchor } from "../lib/selection.js";
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
import { SessionDecisions } from "../collab/DecisionPanel.js";
import { PlanReviewBar, sendRevision } from "../chat/questions/PlanReview.js";
import { QuestionSeatContext } from "../chat/questions/QuestionRecord.js";
import { AnnotationBubble, contentRect, SelectionBar, type BubbleTarget, type ContentRect } from "../review/AnnotationBubble.js";
import { annotationAt, annotationRect, flashAnnotation, highlightsSupported, onAnnotationsPainted, paintedEnds, useAnnotationHighlights } from "../review/highlights.js";
import { annotationNumber, type AnnotationRefs } from "../review/annotationRefs.js";
import { pendingQuestion } from "../chat/questions/flow.js";
import { SlashMenu, useSlashCommands } from "../chat/cli/SlashMenu.js";
import { BackgroundTasks, latestSuggestion, SuggestionChips } from "../chat/cli/ComposerExtras.js";
import { useChatSettings } from "../chat/cli/chatSettings.js";
import { openReview } from "../gitreview/open.js";
import { useMarkSessionSeen } from "../lib/sessionSeen.js";
import { TurnStartHint, useTurnStartHint } from "./TurnStartHint.js";

/** Studio's /compact, as the 压缩 button runs it. */
const COMPACT: SlashCommand = { name: "compact", description: "", group: "studio" };

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
  /** The annotations the next message refers to (批注N tags in the composer, 2026-10-15). */
  annotationRefs?: AnnotationRefs;
  model: string;
  busy: boolean;
  onApprove(item: ApprovalItem, decision: ApprovalDecision): void;
  onJump(sessionId: string): void;
  /** `attachments`: ids of uploaded images sent along. */
  onSend(text: string, attachments: string[]): Promise<boolean>;
  onInterrupt(): void;
  /** Annotating in place (the bubble by the selection): resolve true once saved. */
  onSaveAnnotation(anchor: SelectionAnchor, note: string): Promise<boolean>;
  onEditAnnotation(id: string, note: string): Promise<boolean>;
  onDeleteAnnotation(id: string): void;
  /** A command or another action of the composer failed (stage 12, S12-E). */
  onError?(text: string): void;
  /** Open decisions of this session (AMO decision_request), pinned above the conversation. */
  decisions?: readonly DecisionRequest[];
}

type Menu = { x: number; y: number; anchor: SelectionAnchor } | null;

/** Conversation of one session plus its composer. */
export function Thread({ link, presets, session, profile, tasks = [], sessions = [], items, annotations, annotationRefs, model, busy, onApprove, onJump, onSend, onInterrupt, onSaveAnnotation, onEditAnnotation, onDeleteAnnotation, onError, decisions = [] }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // The composer's text, kept per session across switching and restarts (sessionDraft.ts).
  const sessionId = session?.id ?? null;
  const [held, setHeld] = useState(() => ({ id: sessionId, text: readSessionDraft(sessionId) }));
  const draft = held.id === sessionId ? held.text : readSessionDraft(sessionId);
  const setDraft = useCallback(
    (v: SetStateAction<string>) =>
      setHeld((h) => {
        const text = typeof v === "function" ? v(h.id === sessionId ? h.text : readSessionDraft(sessionId)) : v;
        writeSessionDraft(sessionId, text);
        return { id: sessionId, text };
      }),
    [sessionId],
  );
  const [menu, setMenu] = useState<Menu>(null);
  const view = useTranscriptView();
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
  // `/` at the start: the command menu (stage 12, S12-E).
  const slash = useSlashCommands({ link, session, text: draft, setText: setDraft, onRun: (command, args) => void runCommand(command, args) });
  const chat = useChatSettings(link);
  const suggestion = useMemo(() => latestSuggestion(items), [items]);
  const compacting = useMemo(() => items.some((i) => i.type === "compaction" && i.state === "running"), [items]);
  const resetAttach = attach.reset;
  useEffect(() => resetAttach(), [session?.id, resetAttach]);
  useEffect(() => setFinding(null), [session?.id]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // A question the agent waits on opens as a card over the conversation (a second-level popup: the conversation and
  // the composer keep their place; a plan review sits above the composer instead). It can be folded to a strip, or
  // closed and opened again from its row in the conversation; "要修改" turns the composer into the feedback box.
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

  // Annotating in place: a bar by a fresh selection in a reply, then the bubble to write in (or to change a note, from
  // its highlighted passage).
  const [bar, setBar] = useState<{ anchor: SelectionAnchor; at: ContentRect } | null>(null);
  const [bubble, setBubble] = useState<BubbleTarget | null>(null);
  useEffect(() => {
    setBar(null);
    setBubble(null);
  }, [session?.id]);
  const selectionRect = (): ContentRect | null => {
    const sel = window.getSelection();
    const el = scroller.current;
    if (!el || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? contentRect(el, r) : null;
  };
  const inBubble = (t: EventTarget | null) => t instanceof Element && !!t.closest(".anno-bubble, .sel-bar");

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
  // Painted: the unsent ones, and sent ones the next message refers to again; each gets its 批注N mark.
  const shownAnnotations = annotations.filter((a) => !a.sentAt || annotationRefs?.has(a.id));
  useAnnotationHighlights(scroller, shownAnnotations, sources);
  const marks = useAnnotationMarks(scroller, shownAnnotations, annotations);
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
  // An archived session has no composer (stage 14): the task page's banner says so and restores it.
  const archived = !!session && (session.writer === "archived" || !!session.archivedAt);
  const generating = !!session && (session.status === "running" || session.status === "awaiting-approval" || session.status === "awaiting-answer");
  const turnStart = useTurnStartHint(scroller, sessionId, generating);
  // Focus lists replies that ended while the person was elsewhere; looking at the session here clears them there.
  useMarkSessionSeen(session);
  // Codex steers the running turn at once; Claude reads it after the next tool call, or as the next turn.
  const queues = session?.runtime === "claude";
  const placeholder = readOnly
    ? claudeSub
      ? "Claude 的子 agent 不能单独接收消息，请在父会话里继续。"
      : "会话已交给终端，工作台暂时只读。"
    : isRevising
      ? "写下要修改的地方，回车发给 Claude（计划会按你的意见重写）"
      : planReview
      ? "计划在等你审阅：可以先在这里写下意见，再点上面的「要修改」"
      : generating
      ? queues
        ? "回复生成中，发出的内容会在下一次工具调用后或本轮结束后被读到"
        : "回复生成中，输入的内容会作为插话发出"
      : "继续推进这个会话，回车发送，Shift+回车换行，输入 / 看命令";
  const stats = useMemo(() => sessionStats(items), [items]);
  const sendLabel = generating ? (queues ? "排队" : "插话") : "发送";
  // Images must finish uploading (or be removed when they failed) before the message can go.
  const attachHold = attach.uploading ? "图片上传中…" : attach.failed ? "有图片上传失败，移除后再发送" : "";
  const referring = !isRevising && (annotationRefs?.list.length ?? 0) > 0;
  const canSend = !readOnly && !attachHold && (!!draft.trim() || (!attach.empty && !isRevising) || referring);

  /** "要修改": text already typed goes at once; otherwise the composer collects it. */
  async function revise(feedback: string): Promise<boolean> {
    if (!session || !planReview) return false;
    const failed = await sendRevision(link, session.id, planReview.id, feedback);
    if (failed) return false;
    setRevising(null);
    return true;
  }

  /** Runs a `/` command: Studio's own here (open the Review window), the rest through the Host. */
  async function runCommand(command: SlashCommand, args: string): Promise<boolean> {
    if (!session) return false;
    if (command.local === "open-review") {
      openReview({ workspaceId: session.workspaceId, sessionId: session.id });
      return true;
    }
    stick.current = true;
    setAtBottom(true);
    try {
      await call(link, "POST /api/sessions/:id/commands", { id: session.id }, { name: command.name, ...(args ? { args } : {}) });
      return true;
    } catch (err) {
      onError?.(err instanceof HostApiError ? err.message : String(err));
      return false;
    }
  }

  async function send() {
    const text = draft.trim();
    if (!canSend) return;
    if (isRevising) {
      setDraft("");
      if (!(await revise(text))) setDraft((d) => (d.trim() ? d : text));
      return;
    }
    // A message that starts with a known command runs it; any other text (an unknown /name, a path) is a message.
    const command = text.startsWith("/") ? await slash.match(text) : null;
    if (command) {
      if (!attach.empty) {
        onError?.("命令不能带图片或文件，先移除它们再运行。");
        return;
      }
      setDraft("");
      if (!(await runCommand(command.command, command.args))) setDraft((d) => (d.trim() ? d : text));
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
        <SessionDecisions link={link} decisions={decisions} />
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
            if (inBubble(e.target)) return;
            const anchor = readSelection(sources);
            if (!anchor) return setMenu(null);
            e.preventDefault();
            setBar(null);
            setMenu({ x: e.clientX, y: e.clientY, anchor });
          }}
          onMouseDown={(e) => {
            if (!inBubble(e.target)) setBar(null);
          }}
          onMouseUp={(e) => {
            if (inBubble(e.target) || e.button !== 0) return;
            // After the browser has settled the selection.
            requestAnimationFrame(() => {
              const anchor = readSelection(sources);
              const at = anchor && selectionRect();
              setBar(anchor && at && !bubble ? { anchor, at } : null);
            });
          }}
          onMouseMove={(e) => {
            // The highlighted text takes clicks (stage 13: only the quoted text is highlighted, not its block).
            if (!highlightsSupported()) return;
            const over = !inBubble(e.target) && annotationAt(e.clientX, e.clientY) !== null;
            e.currentTarget.style.cursor = over ? "pointer" : "";
          }}
          onClick={(e) => {
            // A highlighted passage opens its note (when nothing is being selected).
            if (inBubble(e.target) || !window.getSelection()?.isCollapsed) return;
            if (highlightsSupported()) {
              const id = annotationAt(e.clientX, e.clientY);
              const annotation = id ? annotations.find((a) => a.id === id && !a.sentAt) : undefined;
              const rect = id ? annotationRect(id) : null;
              if (annotation && rect && scroller.current) setBubble({ kind: "edit", annotation, at: contentRect(scroller.current, rect) });
              return;
            }
            const block = (e.target as Element).closest<HTMLElement>("[data-annotated]");
            const itemId = block?.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
            if (!block || !itemId || !scroller.current) return;
            const from = Number(block.dataset.srcStart);
            const to = Number(block.dataset.srcEnd);
            const annotation = annotations.find((a) => a.itemId === itemId && !a.sentAt && a.start < to && a.end > from);
            if (annotation) setBubble({ kind: "edit", annotation, at: contentRect(scroller.current, block.getBoundingClientRect()) });
          }}
        >
          {marks.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`anno-mark${annotationRefs?.has(m.id) ? " referred" : ""}`}
              style={{ top: m.top, left: m.left }}
              title={m.title}
              onClick={() => flashAnnotation(m.id)}
              data-testid="annotation-mark"
            >
              批注{m.n}
            </button>
          ))}
          <div className="thread-inner">
            {!session && <div className="thread-empty">这个任务还没有会话。在左侧新建一个会话即可开始。</div>}
            <AttachLink.Provider value={link}>
              <QuestionSeatContext.Provider value={seat}>
                <Transcript session={session} items={items} annotations={annotations} model={model} busy={busy} view={view} onApprove={onApprove} onJump={onJump} />
              </QuestionSeatContext.Provider>
            </AttachLink.Provider>
          </div>
          {bar && !bubble && (
            <SelectionBar
              scroller={scroller}
              at={bar.at}
              canQuote={!readOnly}
              onAnnotate={() => {
                setBubble({ kind: "new", anchor: bar.anchor, at: bar.at });
                setBar(null);
              }}
              onQuote={() => {
                quoteToDraft(bar.anchor.quote);
                setBar(null);
              }}
            />
          )}
          {bubble && (
            <AnnotationBubble
              key={bubble.kind === "edit" ? bubble.annotation.id : `${bubble.anchor.itemId}:${bubble.anchor.start}`}
              scroller={scroller}
              target={bubble}
              onSave={(note) => (bubble.kind === "edit" ? onEditAnnotation(bubble.annotation.id, note) : onSaveAnnotation(bubble.anchor, note))}
              {...(bubble.kind === "edit"
                ? {
                    onDelete: () => {
                      onDeleteAnnotation(bubble.annotation.id);
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
        {turnStart.shown && <TurnStartHint raised={!atBottom} onJump={turnStart.jump} />}
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
        {session && asked && !readOnly && seat.isOpen(asked.id) && (
          <div className="q-popup" data-testid="question-popup">
            <QuestionCard link={link} sessionId={session.id} item={asked} onClose={() => setHiddenCards((cur) => new Set(cur).add(asked.id))} />
          </div>
        )}
      </div>
      {menu && (
        <div className="ctx-menu" role="menu" aria-label="选中文字" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const at = selectionRect() ?? (scroller.current ? contentRect(scroller.current, new DOMRect(menu.x, menu.y, 1, 1)) : null);
              if (at) setBubble({ kind: "new", anchor: menu.anchor, at });
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
      {session && (
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
          <BackgroundTasks link={link} sessionId={session.id} items={items} readOnly={readOnly} onError={(text) => onError?.(text)} />
          {suggestion && chat.settings.promptSuggestions && !generating && !readOnly && !planReview && !draft.trim() && (
            <SuggestionChips
              text={suggestion}
              onPick={(text) => {
                setDraft(text);
                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat-input textarea")?.focus());
              }}
            />
          )}
          {!archived && (
          <div className={`composer-card${readOnly ? " disabled" : ""}${dragging ? " dropping" : ""}`}>
            <AttachTray attach={attach} disabled={readOnly} />
            {annotationRefs && annotationRefs.list.length > 0 && !isRevising && (
              <div className="anno-refs" aria-label="这条消息引用的批注" data-testid="annotation-refs">
                {annotationRefs.list.map((a) => (
                  <span key={a.id} className="anno-ref" title={`「${a.quote}」\n${a.note}`} data-testid="annotation-ref">
                    <button type="button" className="anno-ref-name" onClick={() => flashAnnotation(a.id)}>
                      批注{annotationNumber(a, annotations)}
                    </button>
                    <button type="button" className="anno-ref-x" aria-label={`不引用批注${annotationNumber(a, annotations)}`} title="这条消息不引用它" onClick={() => annotationRefs.remove(a.id)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <label className="chat-input">
              <span className="sr-only">输入消息</span>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  mentions.track(e.target);
                  slash.track(e.target);
                }}
                onSelect={(e) => {
                  mentions.track(e.currentTarget);
                  slash.track(e.currentTarget);
                }}
                onPaste={readOnly ? undefined : attach.onPaste}
                disabled={readOnly}
                rows={2}
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (slash.onKeyDown(e)) return;
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
            <SlashMenu slash={slash} />
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
          )}
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
              {!readOnly && (
                <button
                  type="button"
                  className="link-btn compact-btn"
                  data-testid="compact-button"
                  disabled={generating || compacting}
                  title="压缩上下文：把之前的对话总结成摘要，腾出上下文空间（等这一轮结束后可用）"
                  onClick={() => void runCommand(COMPACT, "")}
                >
                  {compacting ? "压缩中…" : "压缩"}
                </button>
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

/**
 * Where the 批注N marks go: just after the end of each painted annotation, in the scroller's content coordinates, kept
 * up to date as the highlights repaint and the conversation resizes.
 */
function useAnnotationMarks(scroller: RefObject<HTMLDivElement | null>, shown: readonly Annotation[], all: readonly Annotation[]): Array<{ id: string; n: number; top: number; left: number; title: string }> {
  const [marks, setMarks] = useState<Array<{ id: string; n: number; top: number; left: number; title: string }>>([]);
  const latest = useRef({ shown, all });
  latest.current = { shown, all };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const { shown: list, all: every } = latest.current;
      const next = paintedEnds().flatMap(({ id, rect }) => {
        const a = list.find((x) => x.id === id);
        if (!a) return [];
        return [{ id, n: annotationNumber(a, every), top: rect.top - box.top + el.scrollTop - 14, left: Math.min(rect.right - box.left + el.scrollLeft + 2, el.scrollWidth - 48), title: `「${a.quote}」\n${a.note}` }];
      });
      setMarks((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(place);
    };
    const off = onAnnotationsPainted(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    schedule();
    return () => {
      off();
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);
  return marks.filter((m) => shown.some((a) => a.id === m.id));
}
