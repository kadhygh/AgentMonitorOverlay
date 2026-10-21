import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type SetStateAction } from "react";
import { readSessionDraft, writeSessionDraft } from "./sessionDraft.js";
import type { Annotation, ApprovalDecision, DecisionRequest, ModelProfile, Session, SessionItem, SessionPreset, SlashCommand, Task } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { SessionOptionsBar } from "../chat/SessionOptionsBar.js";
import { readSelection, type SelectionAnchor } from "../lib/selection.js";
import { ReplyNav } from "./ReplyNav.js";
import { navHistory } from "../shell/navHistory.js";
import { FindBar } from "../gitreview/FindBar.js";
import { Transcript } from "../chat/Transcript.js";
import { useScrollOnSend, useTranscriptView } from "../chat/prefs.js";
import { IconArrowDown, IconArrowUp, IconStop } from "../chat/icons.js";
import { sessionStats, type ApprovalItem } from "../chat/turns.js";
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
import { WakeBar } from "../chat/WakeBar.js";
import { ContextHint } from "../chat/ContextHint.js";
import { QuestionSeatContext } from "../chat/questions/QuestionRecord.js";
import { AnnotationBubble, contentRect, SelectionBar, type BubbleTarget, type ContentRect } from "../review/AnnotationBubble.js";
import { annotationAt, annotationRect, flashAnnotation, highlightsSupported, useAnnotationHighlights } from "../review/highlights.js";
import { READ_HERE_EVENT } from "../lib/scrollPin.js";
import { readPlaceOf, restoreReadPlace, type ReadPlace } from "./readPlace.js";
import type { AnnotationRefs } from "../review/annotationRefs.js";
import { pendingQuestion } from "../chat/questions/flow.js";
import { SlashMenu, useSlashCommands } from "../chat/cli/SlashMenu.js";
import { BackgroundTasks, latestSuggestion, SuggestionChips } from "../chat/cli/ComposerExtras.js";
import { useChatSettings } from "../chat/cli/chatSettings.js";
import { openReview } from "../gitreview/open.js";
import { awaitsPerson, useMarkSessionSeen, useSessionSeen } from "../lib/sessionSeen.js";
import { cameFromFocus, forgetFocusJump } from "../lib/focusJump.js";
import { TurnStartHint, useTurnStartHint } from "./TurnStartHint.js";
import { useAnnotationMarks } from "./annotationMarks.js";
import { AnnotationRefChips, ComposerStats, composerPlaceholder } from "./ThreadParts.js";

/** Studio's /compact, as the 压缩 button runs it. */
const COMPACT: SlashCommand = { name: "compact", description: "", group: "studio" };
/** A draft is kept this long after typing stops. */
const DRAFT_SAVE_MS = 400;

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
  /** 书签 (2026-10-19) on the selection bar: the selected passage under the session's topic. */
  onBookmark?(anchor: SelectionAnchor): void;
  /** 后退 back to this session: where it had been read (readPlace), restored once its messages are in. */
  initialScroll?: ReadPlace;
  /** Opened at a bookmarked passage (书签): it scrolls there, so no hint about where the turn starts. */
  atPassage?: boolean;
  onEditAnnotation(id: string, note: string): Promise<boolean>;
  onDeleteAnnotation(id: string): void;
  /** A command or another action of the composer failed (stage 12, S12-E). */
  onError?(text: string): void;
  /** Open decisions of this session (AMO decision_request), pinned above the conversation. */
  decisions?: readonly DecisionRequest[];
}


/** Conversation of one session plus its composer. */
export function Thread({ link, presets, session, profile, tasks = [], sessions = [], items, annotations, annotationRefs, model, busy, onApprove, onJump, onSend, onInterrupt, onSaveAnnotation, onEditAnnotation, onDeleteAnnotation, onBookmark, initialScroll, atPassage = false, onError, decisions = [] }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // The composer's text, kept per session across switching and restarts (sessionDraft.ts).
  const sessionId = session?.id ?? null;
  const [held, setHeld] = useState(() => ({ id: sessionId, text: readSessionDraft(sessionId) }));
  const draft = held.id === sessionId ? held.text : readSessionDraft(sessionId);
  // Kept a moment after typing stops, not on every key (2026-10-20: each key read, sorted and wrote every session's
  // draft); written at once when the session changes or the page goes.
  const pendingDraft = useRef<{ id: string | null; text: string } | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushDraft = useCallback(() => {
    clearTimeout(draftTimer.current);
    const p = pendingDraft.current;
    pendingDraft.current = null;
    if (p) writeSessionDraft(p.id, p.text);
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, [sessionId, flushDraft]);
  const setDraft = useCallback(
    (v: SetStateAction<string>) =>
      setHeld((h) => {
        const text = typeof v === "function" ? v(h.id === sessionId ? h.text : readSessionDraft(sessionId)) : v;
        pendingDraft.current = { id: sessionId, text };
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(flushDraft, DRAFT_SAVE_MS);
        return { id: sessionId, text };
      }),
    [sessionId, flushDraft],
  );
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
  // 后退 back here: where it had been read, not the end; once the messages are in.
  const restoreTo = useRef(initialScroll);
  // …and the first "a new session: follow its end" below is not for this one.
  const keepRestored = useRef(initialScroll !== undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (restoreTo.current === undefined || !el || !items.length) return;
    stick.current = false;
    restoreReadPlace(el, restoreTo.current);
    restoreTo.current = undefined;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, [items]);
  // Where it is read, noted for 后退 once a frame while it scrolls.
  const noting = useRef(0);
  useEffect(() => () => cancelAnimationFrame(noting.current), []);
  // Scrolled to a passage or an annotation (scrollToBox): stop following the end at once.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const stay = () => {
      stick.current = false;
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };
    el.addEventListener(READ_HERE_EVENT, stay);
    return () => el.removeEventListener(READ_HERE_EVENT, stay);
  }, [session?.id]);
  useEffect(() => {
    const el = scroller.current?.firstElementChild;
    if (!el) return;
    const ro = new ResizeObserver(toBottom);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session?.id]);
  useEffect(() => {
    // Not for a place gone back to (its reading place was just restored).
    if (keepRestored.current) {
      keepRestored.current = false;
      return;
    }
    stick.current = true;
    setAtBottom(true);
  }, [session?.id]);
  // 发送后跳到最新 (设置 → 界面): a message sent goes straight to the end, wherever the conversation was being read,
  // and the reply is followed. Right away, and once more after the cleared composer and the new message have laid
  // out (a scroll event in between would otherwise turn following off). Off: the reading place stays.
  const jumpOnSend = useScrollOnSend();
  const jumpToEnd = () => {
    if (!jumpOnSend) return;
    const el = scroller.current;
    stick.current = true;
    setAtBottom(true);
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
    });
  };

  // A Claude subagent has no conversation of its own; it is followed from its parent session.
  const claudeSub = session?.runtime === "claude" && session.kind === "sub";
  const readOnly = !session || claudeSub || session.writer === "archived" || session.writer === "terminal-handoff";
  // An archived session has no composer (stage 14): the task page's banner says so and restores it.
  const archived = !!session && (session.writer === "archived" || !!session.archivedAt);
  const generating = !!session && (session.status === "running" || session.status === "awaiting-approval" || session.status === "awaiting-answer");
  // Opened to deal with it (2026-10-21): it waited for the person or had ended unseen, judged as it opens, before
  // opening it counts as seeing it; or Focus just sent the person here for it. Not when it opens at a place of its own
  // (后退, a bookmarked passage).
  const seenData = useSessionSeen();
  const arrival = useRef<{ id: string | null; awaits: boolean }>({ id: null, awaits: false });
  if (session && arrival.current.id !== session.id) arrival.current = { id: session.id, awaits: initialScroll === undefined && !atPassage && (awaitsPerson(session, sessions, seenData) || (cameFromFocus(session.id) && session.status !== "running")) };
  useEffect(() => {
    if (sessionId) forgetFocusJump(sessionId);
  }, [sessionId]);
  const loaded = !!session && items.length > 0 && items[items.length - 1]!.sessionId === session.id;
  const turnStart = useTurnStartHint(scroller, sessionId, generating, arrival.current.id === sessionId && arrival.current.awaits, loaded);
  // Focus lists replies that ended while the person was elsewhere; looking at the session here clears them there.
  useMarkSessionSeen(session);
  // Codex steers the running turn at once; Claude reads it after the next tool call, or as the next turn; DSH only
  // after the turn (stage 17: one prompt at a time).
  const queues = session?.runtime === "claude" || session?.runtime === "dsh";
  const placeholder = composerPlaceholder({ readOnly, claudeSub, isRevising, planReview: !!planReview, generating, queues, waitsForTurn: session?.runtime === "dsh" });
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
    jumpToEnd();
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
    jumpToEnd();
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
        {/* Ctrl+F finds in the conversation on the page (folded steps are not searched). */}
        <FindBar active={!!session} container={scroller} within=".thread-inner" />
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
            if (session && !noting.current) {
              const id = session.id;
              noting.current = requestAnimationFrame(() => {
                noting.current = 0;
                navHistory.noteScroll(id, readPlaceOf(el));
              });
            }
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
              onCopy={() => void copyText(bar.anchor.quote)}
              {...(onBookmark
                ? {
                    onBookmark: () => {
                      onBookmark(bar.anchor);
                      setBar(null);
                      window.getSelection()?.removeAllRanges();
                    },
                  }
                : {})}
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
          {!readOnly && <WakeBar link={link} session={session} />}
          {!readOnly && <ContextHint link={link} session={session} context={stats.context} items={items} busy={generating || compacting} onCompact={() => void runCommand(COMPACT, "")} />}
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
            {annotationRefs && annotationRefs.list.length > 0 && !isRevising && <AnnotationRefChips refs={annotationRefs} annotations={annotations} />}
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
              <span className="composer-hint">{attachHold || (generating && !readOnly && !planReview ? (session?.runtime === "dsh" ? "生成中：本轮结束后发出" : queues ? "生成中：工具调用后或本轮结束后读到" : "生成中：发送会插入到当前回合") : "")}</span>
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
          <ComposerStats stats={stats} canCompact={!readOnly && session?.runtime !== "dsh"} busy={generating || compacting} compacting={compacting} onCompact={() => void runCommand(COMPACT, "")} />
        </div>
      )}
      {finding && session && (
        <FileSelector
          link={link}
          workspaceId={session.workspaceId}
          initialQuery={finding.query}
          onPick={(path) => attach.addFiles([path])}
          onMark={(path) => markFileMessage(link, path, session?.id)}
          onClose={() => {
            setFinding(null);
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat-input textarea")?.focus());
          }}
        />
      )}
    </>
  );
}
