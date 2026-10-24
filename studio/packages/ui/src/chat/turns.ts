import type { SessionItem, ToolKind, TurnUsage } from "@amo-studio/protocol";

// How a session's items read as a conversation, after DSH's chat (ui-chat conversation-nodes):
// each turn is the person's message, the work (thinking and tool calls, foldable), the final answer and a footer.
// Work between two replies forms a group; a group's title summarises what it did ("已读取文件并执行了命令").

export type TurnItem = Extract<SessionItem, { type: "turn" }>;
export type AgentItem = Extract<SessionItem, { type: "agent" }>;
export type ToolItem = Extract<SessionItem, { type: "tool" }>;
export type ReasoningItem = Extract<SessionItem, { type: "reasoning" }>;
export type ApprovalItem = Extract<SessionItem, { type: "approval" }>;
/** Rows that live inside a work group. A pending approval is not one: it stands on its own until answered. */
export type ProcessMember = ReasoningItem | ToolItem | Extract<SessionItem, { type: "subagent" }> | ApprovalItem;

export type Row = { kind: "group"; key: string; members: ProcessMember[]; closed: boolean } | { kind: "item"; key: string; item: SessionItem };

export interface Segment {
  key: string;
  turn: TurnItem | null;
  /** The message(s) that opened the turn. */
  inputs: SessionItem[];
  /** Work and in-between replies: what folding hides. */
  rows: Row[];
  /** The turn's final reply (still streaming while the turn runs). */
  answer: AgentItem | null;
  /** Errors and notices at the end, always shown. */
  tail: SessionItem[];
  running: boolean;
  /** The person wrote again after work had begun: the turn's parts stay in order and do not fold as one. */
  interleaved: boolean;
}

export const turnIdOf = (item: SessionItem): string | undefined => (item.type === "turn" ? item.turnId : item.raw?.turnId);

const isMember = (item: SessionItem): item is ProcessMember =>
  item.type === "reasoning" || item.type === "tool" || item.type === "subagent" || (item.type === "approval" && item.state !== "pending");

/** Thinking that ended with no visible text (encrypted reasoning), or an empty reply, has nothing to show. */
const isEmpty = (item: SessionItem) => (item.type === "reasoning" && !item.streaming && !item.text.trim()) || (item.type === "agent" && !item.streaming && !item.markdown.trim());

/** Items that are not rows: a turn's metadata, background commands (listed above the composer), suggestions. */
const isRowless = (item: SessionItem) => item.type === "turn" || item.type === "background" || item.type === "suggestion";

/** What always shows at the end of a turn, folded or not: errors, notices, a compaction, a command's output. */
const isTail = (item: SessionItem) => item.type === "error" || item.type === "notice" || item.type === "compaction" || item.type === "command";

export function buildTranscript(items: readonly SessionItem[], sessionRunning: boolean): Segment[] {
  const turns = new Map<string, TurnItem>();
  for (const i of items) if (i.type === "turn") turns.set(i.turnId, i);

  // A new segment starts at a message from the person once the current one has more than messages, unless the
  // message belongs to the same turn (steering), and wherever the turn changes.
  const parts: Array<{ turnId: string | undefined; items: SessionItem[] }> = [];
  let cur: (typeof parts)[number] | null = null;
  for (const item of items) {
    if (isRowless(item)) continue;
    const tid = turnIdOf(item);
    const fresh =
      !cur ||
      (item.type === "user" && cur.items.some((i) => i.type !== "user") && (!tid || tid !== cur.turnId)) ||
      (!!tid && !!cur.turnId && tid !== cur.turnId);
    if (fresh) {
      cur = { turnId: tid, items: [] };
      parts.push(cur);
    } else if (!cur!.turnId && tid) cur!.turnId = tid;
    cur!.items.push(item);
  }

  return parts.map((part, index) => {
    const turn = (part.turnId && turns.get(part.turnId)) || null;
    const running = index === parts.length - 1 && sessionRunning && (!turn || turn.state === "running");
    let start = 0;
    while (start < part.items.length && part.items[start]!.type === "user") start++;
    const inputs = part.items.slice(0, start);
    const body = part.items.slice(start).filter((i) => !isEmpty(i));
    let end = body.length;
    while (end > 0 && isTail(body[end - 1]!)) end--;
    const tail = body.slice(end);
    const work = body.slice(0, end);
    const answer = work.at(-1)?.type === "agent" ? (work.pop() as AgentItem) : null;

    const rows: Row[] = [];
    let group: Extract<Row, { kind: "group" }> | null = null;
    let began = false;
    let interleaved = false;
    for (const item of work) {
      if (isMember(item)) {
        if (!group) {
          group = { kind: "group", key: `g-${item.id}`, members: [], closed: true };
          rows.push(group);
        }
        group.members.push(item);
        began = true;
        continue;
      }
      group = null;
      if (item.type === "user" && began) interleaved = true;
      if (item.type === "agent") began = true;
      rows.push({ kind: "item", key: item.id, item });
    }
    // Only the last group of a running turn is still open; a reply or anything else after a group ends it.
    // (An approval it is waiting on does not end it.)
    const lastGroup = rows.findLastIndex((r) => r.kind === "group");
    const waiting = rows.slice(lastGroup + 1).every((r) => r.kind === "item" && (r.item.type === "approval" || r.item.type === "question") && r.item.state === "pending");
    if (running && !answer && lastGroup >= 0 && waiting) (rows[lastGroup] as Extract<Row, { kind: "group" }>).closed = false;
    return { key: part.items[0]!.id, turn, inputs, rows, answer, tail, running, interleaved };
  });
}

/** Whether the turn's work folds away behind its "已完成" line. */
export function foldable(segment: Segment): boolean {
  if (segment.running || segment.interleaved || segment.rows.length === 0) return false;
  return !segment.turn || segment.turn.state === "completed";
}

// ---- activity ---------------------------------------------------------------------------------------------------

export type Activity = "thinking" | "read" | "search" | "edit" | "commands" | "webSearch" | "webFetch" | "subagents" | "plan" | "review" | "tools";

/** Items recorded before tool kinds existed only have a name. */
function legacyKind(name: string): ToolKind {
  switch (name) {
    case "shell":
      return "command";
    case "edit":
    case "write":
      return "edit";
    case "read":
      return "read";
    case "grep":
    case "glob":
      return "search";
    case "web_search":
    case "web_fetch":
      return "web";
    case "agent":
      return "subagent";
    default:
      return "other";
  }
}

export const toolKind = (tool: ToolItem): ToolKind => tool.kind ?? legacyKind(tool.name);

export function activityOf(member: ProcessMember): Activity | null {
  if (member.type === "subagent") return "subagents";
  if (member.type !== "tool") return null;
  switch (toolKind(member)) {
    case "read":
      return "read";
    case "search":
    case "list":
      return "search";
    case "edit":
      return "edit";
    case "command":
      return "commands";
    case "web":
      return member.name === "web_fetch" ? "webFetch" : "webSearch";
    case "subagent":
      return "subagents";
    case "plan":
      return "plan";
    case "review":
      return "review";
    default:
      return "tools";
  }
}

export const LIVE_TITLE: Record<Activity, string> = {
  thinking: "正在分析请求",
  read: "正在读取文件",
  search: "正在搜索代码",
  edit: "正在编辑文件",
  commands: "正在运行命令",
  webSearch: "正在搜索网页",
  webFetch: "正在访问网页",
  subagents: "正在协调子智能体",
  plan: "正在更新计划",
  review: "正在自动审批",
  tools: "正在调用工具",
};

export const DONE_TITLE: Record<Activity, string> = {
  thinking: "已完成分析",
  read: "已读取文件",
  search: "已搜索代码",
  edit: "修改了文件",
  commands: "执行了命令",
  webSearch: "已搜索网页",
  webFetch: "已访问网页",
  subagents: "已协调子智能体",
  plan: "更新了计划",
  review: "自动审批了操作",
  tools: "已调用工具",
};

/** Categories of a group by number of calls, ties in order of first appearance. */
export function activityCounts(members: readonly ProcessMember[]): Array<{ activity: Activity; count: number }> {
  const counts = new Map<Activity, number>();
  for (const m of members) {
    const a = activityOf(m);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts].map(([activity, count]) => ({ activity, count })).sort((a, b) => b.count - a.count);
}

/** A finished group's title: up to three categories, joined the way DSH writes them. */
export function closedTitle(members: readonly ProcessMember[]): { title: string; activity: Activity } {
  const ranked = activityCounts(members).map((c) => c.activity);
  if (ranked.length === 0) return { title: DONE_TITLE.thinking, activity: "thinking" };
  const labels = ranked.slice(0, 3).map((a) => DONE_TITLE[a]);
  let title: string;
  if (labels.length === 1) title = labels[0]!;
  else if (labels.length === 2) title = `${labels[0]}并${labels[0]!.startsWith("已") && labels[1]!.startsWith("已") ? labels[1]!.slice(1) : labels[1]}`;
  else title = labels.join("，");
  if (ranked.length > 3) title += "等";
  return { title, activity: ranked[0]! };
}

/** A running group's title: what it is doing now, and on what. */
export function liveTitle(members: readonly ProcessMember[]): { title: string; detail: string; activity: Activity } {
  const runningTool = [...members].reverse().find((m) => m.type === "tool" && m.status === "running") as ToolItem | undefined;
  if (runningTool) {
    const activity = activityOf(runningTool) ?? "tools";
    return { title: LIVE_TITLE[activity], detail: runningTool.summary, activity };
  }
  return { title: LIVE_TITLE.thinking, detail: "", activity: "thinking" };
}

// ---- numbers ----------------------------------------------------------------------------------------------------

/** "8秒", "1分12秒", "1小时5分" (at least one second, as DSH shows durations). */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 950 → "950", 9600 → "9.6k", 1234567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function turnDuration(turn: TurnItem | null): number | null {
  if (!turn?.endedAt) return null;
  const ms = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The fold line of a finished turn. */
export function turnLabel(turn: TurnItem | null): string {
  if (turn?.state === "failed") return "处理失败";
  if (turn?.state === "interrupted") return "已停止";
  const ms = turnDuration(turn);
  return ms === null ? "已完成" : `已完成，用时 ${formatDuration(ms)}`;
}

export const totalTokens = (u: TurnUsage) => u.input + u.output;

/** How full the session's context is: after the latest turn that reported it. */
export interface ContextUse {
  used: number;
  window: number | null;
  /** Share of the window in use (0-100), when the window is known. */
  percent: number | null;
}

/** Session statistics under the composer: turns, tool calls, tokens, cache hits and context use. */
/**
 * A session's totals for the line under the composer. `subTokens`: what its subagents spent themselves (Claude,
 * 2026-10-17), which its own turns do not count.
 */
export function sessionStats(items: readonly SessionItem[]): { turns: number; steps: number; tokens: number; subTokens: number; cacheHit: number | null; context: ContextUse | null } {
  let turns = 0;
  let subTokens = 0;
  let steps = 0;
  let input = 0;
  let cached = 0;
  let tokens = 0;
  let context: ContextUse | null = null;
  for (const i of items) {
    if (i.type === "turn") {
      turns++;
      if (i.usage) {
        input += i.usage.input;
        cached += i.usage.cachedInput;
        tokens += totalTokens(i.usage);
        if (i.usage.context) {
          const window = i.usage.contextWindow ?? null;
          context = { used: i.usage.context, window, percent: window ? Math.min(100, Math.round((i.usage.context / window) * 100)) : null };
        }
      }
    } else if (i.type === "tool") steps++;
    else if (i.type === "subagent" && i.usage) subTokens += totalTokens(i.usage);
  }
  return { turns, steps, tokens, subTokens, cacheHit: input ? Math.round((cached / input) * 100) : null, context };
}

/** Every item of a segment's work (inside groups too). */
export const segmentMembers = (seg: Segment): SessionItem[] => seg.rows.flatMap((r) => (r.kind === "group" ? r.members : [r.item]));

/**
 * Output speed of a turn in tokens per second, as DSH measures it: the output tokens of its model calls over the time
 * each call spent generating (first output token to its end). Waiting for the first token, tools and approvals are not
 * in it. Null when there is too little to tell, and for turns recorded before Studio measured it.
 */
export function outputSpeed(turn: TurnItem | undefined): number | null {
  const d = turn?.decode;
  if (!d || !d.tokens || !(d.ms >= 300)) return null;
  return Math.round((d.tokens / d.ms) * 1000);
}

// ---- the window drawn ---------------------------------------------------------------------------------------------
// A long session is drawn from its last turns (2026-10-24, after dsh-TUI): its earlier turns wait behind 「显示更早的」.
// Measured on a 4,842-item session in 完全展开: 43,000 elements and 1.3 s of a blocked window on each opening.

/** About how many items the turns drawn at first may hold. */
export const TRANSCRIPT_BUDGET = 400;

/** Roughly what a turn costs to draw: its work counts only when it shows (完全展开 shows every turn's). */
export function segmentWeight(seg: Segment, unfoldedWork: boolean): number {
  const work = unfoldedWork || !foldable(seg) ? segmentMembers(seg).length : 1;
  return seg.inputs.length + work + (seg.answer ? 1 : 0) + seg.tail.length;
}

/**
 * Where the drawn turns start, among `segments` before `end`: back from there while they fit `budget`, at least two
 * turns, and never after the turn keyed `keep` (a place to go back to).
 */
export function windowStart(segments: readonly Segment[], unfoldedWork: boolean, end = segments.length, budget = TRANSCRIPT_BUDGET, keep?: string): number {
  const kept = keep ? segments.findIndex((s) => s.key === keep) : -1;
  let start = end;
  let weight = 0;
  while (start > 0) {
    const next = weight + segmentWeight(segments[start - 1]!, unfoldedWork);
    if (next > budget && end - start >= 2) break;
    weight = next;
    start--;
  }
  return kept >= 0 ? Math.min(start, kept) : start;
}
