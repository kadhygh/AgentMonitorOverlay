import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { packIdOf, reviewTargetOf } from "../viewpacks/logic.js";
import { openReview } from "../gitreview/open.js";
import { openViewer } from "../viewer/open.js";
import type { FileDiff } from "@amo-studio/protocol";
import { Markdown } from "../lib/markdown.js";
import {
  ACTIVITY_ICON,
  IconAgent,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconThink,
  IconX,
} from "./icons.js";
import {
  activityOf,
  closedTitle,
  formatDuration,
  formatTokens,
  liveTitle,
  toolKind,
  type ApprovalItem,
  type ProcessMember,
  type ReasoningItem,
  type ToolItem,
} from "./turns.js";
import type { TranscriptView } from "./prefs.js";
import { FileLink } from "../files/FileLinks.js";
import { Elapsed, ToolImages } from "./cli/CliRows.js";
import { parseInlinePath } from "../files/paths.js";

// Rows of a turn's work, after DSH's ui-chat / ui-tool: a group header summarising the work, and one line per
// thought or tool call that opens into its detail (thinking text, terminal output, diff, input/output).

/** Text with a light sweeping across it while something runs (DSH's TextShimmer). */
export function Shimmer({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  return <span className={`${className ?? ""}${active ? " shimmer" : ""}`.trim() || undefined}>{children}</span>;
}

/** A disclosure line: leading icon (a chevron on hover or when open), then the label. */
function RowButton({
  icon,
  open,
  expandable,
  onToggle,
  children,
  className,
}: {
  icon: ReactNode;
  open: boolean;
  expandable: boolean;
  onToggle(): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`pr-row${expandable ? "" : " static"}${className ? ` ${className}` : ""}`}
      aria-expanded={expandable ? open : undefined}
      onClick={() => expandable && onToggle()}
      tabIndex={expandable ? 0 : -1}
    >
      <span className="pr-lead" aria-hidden="true">
        <span className="pr-icon">{icon}</span>
        {expandable && <span className="pr-chev">{open ? <IconChevronUp /> : <IconChevronDown />}</span>}
      </span>
      {children}
    </button>
  );
}

// ---- thinking ---------------------------------------------------------------------------------------------------

function firstLine(text: string): string {
  return text.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
}

export function ReasoningRow({ item, view }: { item: ReasoningItem; view: TranscriptView }) {
  const [open, setOpen] = useState(false);
  const label = item.streaming ? "思考中" : item.durationMs ? `已思考 ${formatDuration(item.durationMs)}` : "已思考";
  // The preview is the first finished line: a line still being written would flicker.
  const settled = item.streaming ? item.text.slice(0, item.text.lastIndexOf("\n") + 1) : item.text;
  const preview = view === "compact" ? "" : firstLine(settled);
  return (
    <div className="pr pr-think" data-testid="reasoning" data-streaming={item.streaming || undefined}>
      <RowButton icon={<IconThink />} open={open} expandable={!!item.text.trim()} onToggle={() => setOpen((v) => !v)}>
        <Shimmer active={item.streaming} className="pr-title">
          {label}
        </Shimmer>
        {preview && !open && (
          <>
            <span className="pr-dot" />
            <span className="pr-summary">{preview}</span>
          </>
        )}
      </RowButton>
      {open && (
        <div className="pr-body pr-think-body">
          <Markdown source={item.text} />
        </div>
      )}
    </div>
  );
}

// ---- tools ------------------------------------------------------------------------------------------------------

export function toolTitle(tool: ToolItem): string {
  switch (toolKind(tool)) {
    case "read":
      return "读取";
    case "search":
      return "搜索";
    case "list":
      return "查看目录";
    case "command":
      return "运行命令";
    case "edit":
      return tool.name === "write" ? "写入" : "编辑";
    case "web":
      return tool.name === "web_fetch" ? "网页获取" : "网页搜索";
    case "plan":
      return "更新计划";
    case "review":
      return "自动审批";
    case "subagent":
      return "子智能体";
    default:
      return "工具调用";
  }
}

function toolSummary(tool: ToolItem): string {
  const kind = toolKind(tool);
  if (kind === "mcp" || kind === "other") return tool.summary && tool.summary !== tool.name ? `${tool.name} · ${tool.summary}` : tool.name;
  return tool.summary;
}

const STATUS_NOTE: Partial<Record<ToolItem["status"], string>> = { failed: "失败", declined: "未执行" };
/** A review row's summary already says approved / denied. */
const noteFor = (item: ToolItem) => (toolKind(item) === "review" ? undefined : STATUS_NOTE[item.status]);

function DiffStat({ files }: { files: readonly FileDiff[] }) {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (!added && !removed) return null;
  return (
    <span className="pr-diffstat" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
      <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </span>
  );
}

export function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const activity = activityOf(item) ?? "tools";
  const Icon = ACTIVITY_ICON[activity];
  const kind = toolKind(item);
  const running = item.status === "running";
  const expandable = !!(item.detail || item.input || item.files?.some((f) => f.diff) || kind === "command");
  const summary = toolSummary(item);
  const note = noteFor(item);
  // A read or an edit of one file: its name opens the quick look (stage 12).
  const mention = kind === "read" || kind === "edit" ? parseInlinePath(summary) : null;
  // 查看包 (2026-10-23): a view_open (or review_open) call can open its pack again from here.
  const pack = kind === "mcp" && item.status === "completed" ? packIdOf(item.name, item.detail) : null;
  // review_open on a whole project opened the Review window, not a pack: the same button opens it again.
  const reviewAgain = kind === "mcp" && item.status === "completed" && !pack ? reviewTargetOf(item.name, item.detail) : null;
  return (
    <div className="pr pr-tool" data-testid="tool" data-status={item.status} data-kind={kind}>
      <RowButton icon={<Icon />} open={open} expandable={expandable} onToggle={() => setOpen((v) => !v)}>
        <Shimmer active={running} className="pr-title">
          {toolTitle(item)}
        </Shimmer>
        {summary && (
          <>
            <span className="pr-dot" />
            <span className={`pr-summary${kind === "command" || kind === "search" ? " code" : ""}${item.status === "failed" || (kind === "review" && item.status === "declined") ? " failed" : ""}`}>
              {mention ? (
                <FileLink nested path={mention.path} line={mention.line} cwd={item.cwd}>
                  {summary}
                </FileLink>
              ) : (
                summary
              )}
            </span>
          </>
        )}
        {item.files && <DiffStat files={item.files} />}
        {item.progress && (
          <span className="pr-progress" data-testid="tool-progress" title={item.progress}>
            {item.progress}
          </span>
        )}
        {running && <Elapsed since={item.createdAt} />}
        {note && <span className={`pr-note ${item.status}`}>{note}</span>}
      </RowButton>
      {item.images?.length ? <ToolImages images={item.images} /> : null}
      {pack && (
        <button type="button" className="btn-ghost small pr-pack" onClick={() => openViewer({ path: "", pack })} title="再打开这个查看包" data-testid="tool-open-pack">
          打开查看包
        </button>
      )}
      {reviewAgain && (
        <button type="button" className="btn-ghost small pr-pack" onClick={() => openReview({ ...reviewAgain, nonce: `again-${Date.now()}` })} title="再打开 agent 打开过的这个 Review" data-testid="tool-open-review">
          打开 Review
        </button>
      )}
      {open && <div className="pr-body">{toolBody(item)}</div>}
    </div>
  );
}

function toolBody(item: ToolItem): ReactNode {
  const kind = toolKind(item);
  if (kind === "edit" && item.files?.length) return item.files.map((f) => <DiffCard key={f.path} file={f} cwd={item.cwd} />);
  if (kind === "command" || kind === "read" || kind === "search" || kind === "list") return <TerminalCard item={item} />;
  if (kind === "plan") return <pre className="pr-plan">{item.input ?? item.detail ?? ""}</pre>;
  if (kind === "review") return <div className="pr-review">{item.detail || "（审查 agent 没有给出理由）"}</div>;
  return <IoCard input={item.input} output={item.detail} />;
}

/** A command and its output, like a terminal (DSH TerminalBlock). Follows new output while it runs. */
function TerminalCard({ item }: { item: ToolItem }) {
  const out = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = out.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [item.detail]);
  const failed = item.status === "failed" || (item.exitCode != null && item.exitCode !== 0);
  // A long output shows its end (where a running command is); the rest on request (2026-10-20: all of it was set
  // again on every new chunk).
  const [full, setFull] = useState(false);
  const text = (item.detail ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = full ? null : text.split("\n");
  const hidden = lines && lines.length > OUTPUT_LINES_SHOWN ? lines.length - OUTPUT_LINES_SHOWN : 0;
  return (
    <div className="pr-term">
      <div className="pr-term-cmd">
        <span className="pr-term-prompt" aria-hidden="true">
          $
        </span>
        <code>{item.input || item.summary}</code>
      </div>
      {item.detail ? (
        <>
          {hidden > 0 && (
            <button type="button" className="show-all" onClick={() => setFull(true)} data-testid="show-all">
              前面还有 {hidden} 行 · 显示全部
            </button>
          )}
          <pre
            className="pr-term-out"
            ref={out}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {hidden > 0 ? lines!.slice(hidden).join("\n") : text}
          </pre>
        </>
      ) : (
        <div className="pr-term-empty">{item.status === "running" ? "运行中…" : "（没有输出）"}</div>
      )}
      {(item.exitCode != null || item.durationMs != null) && item.status !== "running" && (
        <div className={`pr-term-foot${failed ? " failed" : ""}`}>
          {item.exitCode != null && <span>退出码 {item.exitCode}</span>}
          {item.durationMs != null && <span>{formatDuration(item.durationMs)}</span>}
        </div>
      )}
    </div>
  );
}

/** One file's change, coloured by line (DSH DiffBlock). */
function DiffCard({ file, cwd }: { file: FileDiff; cwd?: string | undefined }) {
  const all = (file.diff ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  // A long patch (a new 5000-line file) shows its start; the rest on request (2026-10-20: every line was drawn).
  const [full, setFull] = useState(false);
  const lines = full ? all : all.slice(0, DIFF_LINES_SHOWN);
  return (
    <div className="pr-diff">
      <div className="pr-diff-head">
        <span className="pr-diff-path">
          <FileLink path={file.path} cwd={cwd}>
            {file.path}
          </FileLink>
        </span>
        <span className="pr-diff-change">{file.change === "add" ? "新文件" : file.change === "delete" ? "已删除" : ""}</span>
        <DiffStat files={[file]} />
      </div>
      {file.diff && (
        <div className="pr-diff-body">
          {lines.map((line, i) => {
            const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
            return (
              <div key={i} className={`pr-diff-line ${cls}`}>
                <span className="pr-diff-mark" aria-hidden="true">
                  {cls === "add" ? "+" : cls === "del" ? "−" : ""}
                </span>
                <span className="pr-diff-text">{cls === "hunk" ? line : line.slice(1) || " "}</span>
              </div>
            );
          })}
          {lines.length < all.length && (
            <button type="button" className="show-all" onClick={() => setFull(true)} data-testid="show-all">
              还有 {all.length - lines.length} 行 · 显示全部
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lines of a patch shown before 显示全部, and of a command's output (its end). */
const DIFF_LINES_SHOWN = 400;
const OUTPUT_LINES_SHOWN = 1500;

/** Input and output of a generic tool call (DSH's IN/OUT card). */
function IoCard({ input, output }: { input?: string; output?: string }) {
  return (
    <div className="pr-io">
      {input && (
        <div className="pr-io-sec">
          <span className="pr-io-label">IN</span>
          <pre>{input}</pre>
        </div>
      )}
      {output && (
        <div className="pr-io-sec">
          <span className="pr-io-label">OUT</span>
          <pre>{output}</pre>
        </div>
      )}
      {!input && !output && <div className="pr-term-empty">（没有内容）</div>}
    </div>
  );
}

// ---- approvals and subagents inside the work --------------------------------------------------------------------

const APPROVAL_DONE: Record<Exclude<ApprovalItem["state"], "pending">, string> = { accepted: "已批准", declined: "已拒绝", "resolved-elsewhere": "已在别处处理" };
const APPROVAL_WHAT: Record<ApprovalItem["kind"], string> = { command: "执行命令", fileChange: "修改文件", permissions: "请求" };

/** An answered approval: one quiet line in the work. */
function ApprovalRow({ item }: { item: ApprovalItem }) {
  const state = item.state === "pending" ? "accepted" : item.state;
  return (
    <div className="pr pr-approval" data-testid="approval" data-state={item.state}>
      <RowButton icon={state === "declined" ? <IconX /> : <IconCheck />} open={false} expandable={false} onToggle={() => undefined} className={state}>
        <span className="pr-title">
          {APPROVAL_DONE[state]}
          {APPROVAL_WHAT[item.kind]}
        </span>
        <span className="pr-dot" />
        <span className="pr-summary code">{item.summary}</span>
      </RowButton>
    </div>
  );
}

function SubagentRow({ item, onJump }: { item: Extract<ProcessMember, { type: "subagent" }>; onJump(id: string): void }) {
  return (
    <div className="pr pr-sub" data-testid="msg-subagent">
      <RowButton icon={<IconAgent />} open={false} expandable={false} onToggle={() => undefined}>
        <span className="pr-title">子智能体</span>
        <span className="pr-dot" />
        <span className="pr-summary">{item.summary}</span>
        {item.usage && (
          <span className="pr-meta" title="这个子 agent 自己用掉的 token" data-testid="subagent-usage">
            用量 {formatTokens(item.usage.input + item.usage.output)}
          </span>
        )}
      </RowButton>
      <button type="button" className="pr-link" onClick={() => onJump(item.childSessionId)}>
        查看
      </button>
    </div>
  );
}

export function MemberRow({ item, view, onJump }: { item: ProcessMember; view: TranscriptView; onJump(id: string): void }) {
  switch (item.type) {
    case "reasoning":
      return <ReasoningRow item={item} view={view} />;
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return <ApprovalRow item={item} />;
    case "subagent":
      return <SubagentRow item={item} onJump={onJump} />;
  }
}

// ---- a group of work --------------------------------------------------------------------------------------------

/**
 * Consecutive work between two replies. Its header names what it did (or is doing); the body opens on demand,
 * scrolls within a capped height and follows new rows while at its bottom.
 */
export function ProcessGroup({
  members,
  closed,
  view,
  flat,
  onJump,
}: {
  members: readonly ProcessMember[];
  closed: boolean;
  view: TranscriptView;
  /** Show the rows without a header (详细 while running, 完全展开 always). */
  flat: boolean;
  onJump(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [fade, setFade] = useState({ top: false, bottom: false });

  const measure = () => {
    const el = body.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  };
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (follow.current) el.scrollTop = el.scrollHeight;
    measure();
  });
  // Opening a group that is still working starts at its newest row; a finished one starts at the top.
  useEffect(() => {
    follow.current = !closed;
    const el = body.current;
    if (el) el.scrollTop = closed ? 0 : el.scrollHeight;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = members.map((m) => <MemberRow key={m.id} item={m} view={view} onJump={onJump} />);
  if (flat)
    return (
      <div className="pg pg-flat" data-testid="process-group" data-flat="">
        {rows}
      </div>
    );

  const live = !closed ? liveTitle(members) : null;
  const done = closed ? closedTitle(members) : null;
  const activity = live?.activity ?? done!.activity;
  const Icon = ACTIVITY_ICON[activity];
  const title = live ? (view === "compact" || !live.detail ? live.title : `${live.title} · ${live.detail}`) : done!.title;
  return (
    <div className="pg" data-testid="process-group" data-closed={closed || undefined}>
      <button type="button" className="pg-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="pr-lead" aria-hidden="true">
          <span className="pr-icon">
            <Icon />
          </span>
          <span className="pr-chev">{open ? <IconChevronUp /> : <IconChevronDown />}</span>
        </span>
        <Shimmer active={!closed} className="pg-title">
          {title}
        </Shimmer>
      </button>
      {open && (
        <div
          ref={body}
          className={`pg-body${fade.top ? " fade-top" : ""}${fade.bottom ? " fade-bottom" : ""}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            measure();
          }}
        >
          {rows}
        </div>
      )}
    </div>
  );
}
