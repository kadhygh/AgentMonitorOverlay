import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ApprovalDecision, Session, SessionItem, TurnUsage } from "@amo-studio/protocol";
import { splitAnnotationRefs } from "@amo-studio/protocol";
import { Markdown } from "../lib/markdown.js";
import { copyText } from "../host/client.js";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconTerminal, IconSparkle } from "./icons.js";
import { ProcessGroup, Shimmer, MemberRow } from "./ProcessRows.js";
import { buildTranscript, foldable, formatDuration, formatTokens, outputSpeed, segmentMembers, turnLabel, type AgentItem, type ApprovalItem, type Row, type Segment, type TurnItem } from "./turns.js";
import type { TranscriptView } from "./prefs.js";
import { MessageFiles, MessageImages } from "../attach/MessageAttachments.js";
import { splitFileRefItems } from "../attach/refs.js";
import { TurnChanges } from "../files/ChangedFiles.js";
import { QuestionRecord } from "./questions/QuestionRecord.js";
import { CommandRecord, CompactionRow, NoticeRow } from "./cli/CliRows.js";
import { RowBoundary } from "../lib/ErrorBoundary.js";

// The conversation, one turn after another (DSH ui-chat): the person's bubble, the work (folded once the turn is
// done), the answer, and a footer with copy, time and token usage. A running turn ends with a live status line.

/** Asks the transcript to unfold whatever hides an item (e.g. to locate an annotation). */
export const REVEAL_ITEM_EVENT = "amo:reveal-item";

interface TranscriptProps {
  session: Session | null;
  items: readonly SessionItem[];
  annotations: readonly Annotation[];
  model: string;
  busy: boolean;
  view: TranscriptView;
  onApprove(item: ApprovalItem, decision: ApprovalDecision): void;
  onJump(sessionId: string): void;
}

export function Transcript({ session, items, annotations, model, busy, view, onApprove, onJump }: TranscriptProps) {
  const sessionRunning = session?.status === "running" || session?.status === "awaiting-approval" || session?.status === "awaiting-answer";
  const segments = useMemo(() => buildTranscript(items, sessionRunning), [items, sessionRunning]);
  // Turns the person unfolded (or folded again); finished turns start folded.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setUnfolded(new Set()), [session?.id]);

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  useEffect(() => {
    const reveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const seg = segmentsRef.current.find((s) => s.rows.some((r) => (r.kind === "item" ? r.item.id === id : r.members.some((m) => m.id === id))));
      if (seg) setUnfolded((cur) => new Set(cur).add(seg.key));
    };
    window.addEventListener(REVEAL_ITEM_EVENT, reveal);
    return () => window.removeEventListener(REVEAL_ITEM_EVENT, reveal);
  }, []);

  const highlights = (id: string) => annotations.filter((a) => a.itemId === id && !a.sentAt);
  const last = segments.at(-1);
  const runningTurn = last?.running ? last.turn : null;

  return (
    <>
      {segments.map((seg, i) => (
        // One turn that cannot be drawn shows a line saying so; the turns around it stay.
        <RowBoundary key={seg.key} what="这一轮">
        <TurnView
          seg={seg}
          latest={i === segments.length - 1}
          view={view}
          model={model}
          busy={busy}
          unfolded={unfolded.has(seg.key)}
          onToggle={() =>
            setUnfolded((cur) => {
              const next = new Set(cur);
              if (next.has(seg.key)) next.delete(seg.key);
              else next.add(seg.key);
              return next;
            })
          }
          highlights={highlights}
          onApprove={onApprove}
          onJump={onJump}
        />
        </RowBoundary>
      ))}
      {sessionRunning && (
        <RunningStatus
          turn={runningTurn}
          compacting={!!last?.running && [...segmentMembers(last), ...last.tail].some((i) => i.type === "compaction" && i.state === "running")}
          awaiting={session?.status === "awaiting-answer" ? "等你回答" : session?.status === "awaiting-approval" ? "等待你的确认" : null}
        />
      )}
    </>
  );
}

function TurnView({
  seg,
  latest,
  view,
  model,
  busy,
  unfolded,
  onToggle,
  highlights,
  onApprove,
  onJump,
}: {
  seg: Segment;
  latest: boolean;
  view: TranscriptView;
  model: string;
  busy: boolean;
  unfolded: boolean;
  onToggle(): void;
  highlights(id: string): Annotation[];
  onApprove: TranscriptProps["onApprove"];
  onJump(id: string): void;
}) {
  const canFold = foldable(seg) && view !== "verbose";
  const folded = canFold && !unfolded;
  const finished = !seg.running;
  const flat = view === "verbose" || (view === "detailed" && seg.running);
  return (
    <section className="turn" data-testid="turn" data-running={seg.running || undefined} data-folded={folded || undefined}>
      {seg.inputs.map((item) => (item.type === "user" ? <UserBubble key={item.id} item={item} /> : null))}
      {finished && seg.rows.length > 0 && (
        <button
          type="button"
          className={`turn-fold${canFold ? "" : " static"}${seg.turn?.state === "failed" ? " failed" : seg.turn?.state === "interrupted" ? " stopped" : ""}`}
          data-testid="turn-fold"
          aria-expanded={canFold ? !folded : undefined}
          onClick={() => canFold && onToggle()}
          tabIndex={canFold ? 0 : -1}
        >
          <span className="turn-fold-label">{turnLabel(seg.turn)}</span>
          {canFold && <span className="turn-fold-chev" aria-hidden="true">{folded ? <IconChevronRight /> : <IconChevronDown />}</span>}
        </button>
      )}
      {!folded && seg.rows.length > 0 && (
        <div className="turn-work">
          {seg.rows.map((row) => (
            <RowBoundary key={row.key}>
              <RowView row={row} view={view} flat={flat} busy={busy} highlights={highlights} onApprove={onApprove} onJump={onJump} />
            </RowBoundary>
          ))}
        </div>
      )}
      {/* What the person answered stays in sight when the turn's work folds away (like their messages). */}
      {folded &&
        seg.rows.map((row) =>
          row.kind === "item" && row.item.type === "question" ? (
            <QuestionRecord key={row.key} item={row.item} />
          ) : row.kind === "item" && row.item.type === "compaction" ? (
            <CompactionRow key={row.key} item={row.item} />
          ) : null,
        )}
      {seg.answer && <AgentReply item={seg.answer} highlights={highlights(seg.answer.id)} />}
      {finished && <TurnChanges items={segmentMembers(seg)} />}
      {seg.tail.map((item) => (
        <RowBoundary key={item.id}>
          <StandaloneItem item={item} busy={busy} highlights={highlights} onApprove={onApprove} />
        </RowBoundary>
      ))}
      {finished && seg.answer && !seg.answer.streaming && (
        <TurnFooter answer={seg.answer} usage={seg.turn?.usage} speed={outputSpeed(seg.turn ?? undefined)} endedAt={seg.turn?.endedAt} model={model} always={latest} />
      )}
    </section>
  );
}

function RowView({
  row,
  view,
  flat,
  busy,
  highlights,
  onApprove,
  onJump,
}: {
  row: Row;
  view: TranscriptView;
  flat: boolean;
  busy: boolean;
  highlights(id: string): Annotation[];
  onApprove: TranscriptProps["onApprove"];
  onJump(id: string): void;
}) {
  if (row.kind === "group") {
    // A single thought needs no header of its own.
    if (row.members.length === 1 && row.members[0]!.type === "reasoning") return <MemberRow item={row.members[0]!} view={view} onJump={onJump} />;
    return <ProcessGroup members={row.members} closed={row.closed} view={view} flat={flat || (view === "detailed" && !row.closed)} onJump={onJump} />;
  }
  return <StandaloneItem item={row.item} busy={busy} highlights={highlights} onApprove={onApprove} />;
}

function StandaloneItem({ item, busy, highlights, onApprove }: { item: SessionItem; busy: boolean; highlights(id: string): Annotation[]; onApprove: TranscriptProps["onApprove"] }) {
  switch (item.type) {
    case "user":
      return <UserBubble item={item} />;
    case "agent":
      return <AgentReply item={item} highlights={highlights(item.id)} />;
    case "approval":
      return <ApprovalCard item={item} busy={busy} onApprove={onApprove} />;
    case "question":
      return <QuestionRecord item={item} />;
    case "error":
      return (
        <div className="msg-error" role="alert" data-testid="msg-error">
          <span className="state-dot error" aria-hidden="true" />
          <span className="msg-error-title">本轮运行失败</span>
          <span className="msg-error-text">{item.message}</span>
        </div>
      );
    case "notice":
      return <NoticeRow item={item} />;
    case "compaction":
      return <CompactionRow item={item} />;
    case "command":
      return <CommandRecord item={item} />;
    default:
      return null;
  }
}

/**
 * The person's message: images first, then the annotations it referred to (批注N tags, 2026-10-15), the text, then the
 * files it referenced (both read back from the text).
 */
function UserBubble({ item }: { item: Extract<SessionItem, { type: "user" }> }) {
  const { text: own, refs: annotations } = splitAnnotationRefs(item.text);
  const { text, refs } = splitFileRefItems(own);
  return (
    <div className="msg-user-row">
      <div className="msg-user" data-testid="msg-user">
        {item.images?.length ? <MessageImages images={item.images} /> : null}
        {annotations.length > 0 && (
          <span className="msg-anno-refs">
            {annotations.map((r) => (
              <span key={r.n} className="anno-ref sent" title={`「${r.quote}」\n${r.note}`} data-testid="msg-annotation-ref">
                批注{r.n}
              </span>
            ))}
          </span>
        )}
        {text && <span className="msg-text">{text}</span>}
        <MessageFiles files={refs} />
      </div>
    </div>
  );
}

function AgentReply({ item, highlights }: { item: AgentItem; highlights: readonly Annotation[] }) {
  return (
    <div className="msg-agent" data-testid="msg-agent" data-item-id={item.id} data-item-type="agent" data-streaming={item.streaming || undefined}>
      {item.markdown ? <Markdown source={item.markdown} highlights={highlights} /> : null}
      {item.streaming && <span className="stream-caret" aria-label="生成中" />}
    </div>
  );
}

const APPROVAL_TITLE: Record<ApprovalItem["kind"], string> = { command: "请求执行命令", fileChange: "请求修改文件", permissions: "请求更多权限" };

function ApprovalCard({ item, busy, onApprove }: { item: ApprovalItem; busy: boolean; onApprove: TranscriptProps["onApprove"] }) {
  const Icon = item.kind === "command" ? IconTerminal : item.kind === "fileChange" ? IconEdit : IconSparkle;
  return (
    <div className="approval pending" data-testid="approval" data-state={item.state}>
      <div className="approval-head">
        <Icon />
        <span className="approval-title">{APPROVAL_TITLE[item.kind]}</span>
        <span className="approval-wait">等待你的确认</span>
      </div>
      <code className="approval-detail">{item.summary}</code>
      {item.detail && <span className="approval-cwd">{item.detail}</span>}
      <div className="approval-actions">
        <button type="button" className="btn-attention" disabled={busy} onClick={() => onApprove(item, "accept")}>
          批准
        </button>
        <button type="button" className="btn-outline-attention" disabled={busy} onClick={() => onApprove(item, "decline")}>
          拒绝
        </button>
      </div>
    </div>
  );
}

// ---- footer -----------------------------------------------------------------------------------------------------

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function TurnFooter({ answer, usage, speed, endedAt, model, always }: { answer: AgentItem; usage?: TurnUsage; speed: number | null; endedAt?: string; model: string; always: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="turn-foot" data-reveal={always ? "always" : "hover"} data-testid="turn-foot">
      <button
        type="button"
        className="icon-btn"
        aria-label={copied ? "已复制" : "复制回复"}
        title={copied ? "已复制" : "复制回复"}
        onClick={() => void copyText(answer.markdown).then(() => setCopied(true))}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      <span className="turn-foot-time">{clock(endedAt ?? answer.createdAt)}</span>
      {usage && <UsageButton usage={usage} speed={speed} model={model} />}
      {speed !== null && (
        <span className="turn-foot-speed" title="输出 token ÷ 生成用时：每次模型调用从第一个输出 token 到结束（不含等首个 token、命令、工具和等你确认的时间，和 DSH 一样）" data-testid="turn-speed">
          {speed} tok/s
        </span>
      )}
    </div>
  );
}

const n = (v: number) => v.toLocaleString("en-US");

function UsageButton({ usage, speed, model }: { usage: TurnUsage; speed: number | null; model: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
    };
  }, [open]);
  const hit = usage.input ? Math.round((usage.cachedInput / usage.input) * 100) : null;
  return (
    <span className="usage" ref={box}>
      <button type="button" className="usage-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        用量 {formatTokens(usage.input + usage.output)}
      </button>
      {open && (
        <div className="usage-panel" role="dialog" aria-label="本轮用量">
          <div className="usage-title">本轮用量</div>
          <dl>
            <dt>模型</dt>
            <dd>{model}</dd>
            {hit !== null && (
              <>
                <dt>缓存命中</dt>
                <dd>{hit}%</dd>
              </>
            )}
            <dt>未缓存输入</dt>
            <dd>{n(usage.input - usage.cachedInput)} tok</dd>
            <dt>缓存读取</dt>
            <dd>{n(usage.cachedInput)} tok</dd>
            <dt>输出</dt>
            <dd>
              {n(usage.output)} tok{usage.reasoning ? `（其中推理 ${n(usage.reasoning)}）` : ""}
            </dd>
            {speed !== null && (
              <>
                <dt>输出速度</dt>
                <dd>{speed} tok/s</dd>
              </>
            )}
            {usage.context !== undefined && (
              <>
                <dt>上下文</dt>
                <dd>
                  {formatTokens(usage.context)}
                  {usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)} · ${Math.round((usage.context / usage.contextWindow) * 100)}%` : " tok"}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </span>
  );
}

// ---- running status ---------------------------------------------------------------------------------------------

/**
 * The live line at the bottom while the session works: the robot, the elapsed time and (once known) the speed.
 * `awaiting`: what the session waits for from the person ("等待你的确认", "等你回答"), or null while it works. While the
 * CLI retries a model request or compacts the context, the line says so instead (stage 12, S12-E).
 */
function RunningStatus({ turn, awaiting, compacting }: { turn: TurnItem | null; awaiting: string | null; compacting: boolean }) {
  const startedAt = turn?.startedAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const speed = outputSpeed(turn ?? undefined);
  const retry = turn?.retry;
  const label = awaiting
    ? awaiting
    : retry
      ? `正在重试 ${retry.attempt}${retry.max ? `/${retry.max}` : ""} · ${retry.reason}`
      : compacting
        ? "正在压缩上下文…"
        : Number.isFinite(start)
      ? `正在工作，用时 ${formatDuration(Math.max(1000, now - start))}${speed !== null ? ` · ${speed} tok/s` : ""} ···`
      : "正在工作";
  return (
    <div className="run-status" data-testid="run-status" data-retrying={retry ? "" : undefined}>
      <span className="sr-only" role="status" aria-live="polite">
        {awaiting ?? "正在工作"}
      </span>
      <img className={`run-bot${awaiting ? " waiting" : ""}`} src="./icon.svg" alt="" aria-hidden="true" />
      <Shimmer active={!awaiting} className="run-text">
        {label}
      </Shimmer>
    </div>
  );
}
