import type { PermissionResult, Query, SDKUserMessage, SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { McpLaunch } from "../mcp-launch.js";
import type { McpServerSpec } from "@amo-studio/protocol";
import type { Id, QuestionPrompt, SessionStatus } from "@amo-studio/protocol";

// What Studio keeps about one running Claude Code process of a session (stage 16 split out of claude-runtime.ts).

export interface PendingApproval {
  itemId: Id;
  input: Record<string, unknown>;
  toolUseId: string | null;
  resolve(result: PermissionResult): void;
}

/** AskUserQuestion or ExitPlanMode waiting in canUseTool for the person's answer (a `question` item). */
export interface PendingQuestion {
  itemId: Id;
  kind: "ask" | "plan";
  input: Record<string, unknown>;
  questions: QuestionPrompt[];
  resolve(result: PermissionResult): void;
}

/** Tools whose call is the person's to answer: shown as a question item rather than a tool row. */
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * One message for the CLI's input: `uuid` names it in command_lifecycle. No `priority: "now"` for 立即发送 any more
 * (2026-11-03, 问题 #16): it waited out a running shell command; the Send now request is used instead.
 */
export interface LiveInput {
  content: SDKUserMessage["message"]["content"];
  uuid: string;
}

/** One running Claude Code process for a session, fed through a streaming input. */
export interface Live {
  q: Query;
  /** Settles when the query has ended and its process is gone. */
  done: Promise<void>;
  push(input: LiveInput): void;
  end(): void;
  running: boolean;
  /** Settles once the session's permission mode is in force (see ensureLive). */
  ready: Promise<void>;
  interrupted: boolean;
  /**
   * 立即发送 (2026-11-02): the turn ends to give way to a waiting message, not because the person stopped it — its end
   * is "interrupted" (the CLI says error_during_execution), and nothing of 停止 (declined approvals, the 15 s close) runs.
   */
  givingWay: boolean;
  /** What the CLI said it can do (system/init `capabilities`): msg_lifecycle_v1, interrupt_send_now_v1… */
  capabilities: Set<string>;
  /**
   * MCP 设置 (2026-11-04): what the process was started with, the AMO server it was given (setMcpServers replaces the
   * whole dynamic set, amo included), the servers added since (`dynamic`; those of the start stay until the process
   * ends, whatever setMcpServers says — seen with CLI 2.1.304), and whether a change needs a new process.
   */
  mcp: { plan: McpLaunch; amo: unknown; dynamic: Record<string, McpServerSpec> } | null;
  mcpStale: boolean;
  /**
   * Messages Studio sent that the model has not read yet (command_lifecycle `started` not seen): uuid -> its user item.
   * Still here when the process goes: those items become `unsent`.
   */
  undelivered: Map<string, Id>;
  /**
   * Of those, the ones in the CLI's queue (command_lifecycle `queued`), and who waits for one to get there: Send now
   * finds nothing waiting for a message the CLI is still taking in (2026-11-02, seen right after sending it).
   */
  atCli: Set<string>;
  onAtCli: Map<string, () => void>;
  /** Closed by Studio (idle, archive, Host shutdown) rather than ended by the CLI. */
  closedByHost: boolean;
  /** Its end handled (finish): once, also when Studio gave up waiting for a stuck process. */
  finished?: boolean;
  /** Message types Studio failed to handle in this query (each told once in the conversation). */
  handlerErrors: Set<string>;
  background: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Tokens in the context after the latest model call of this turn (from the assistant messages' usage). */
  context?: number;
  /** The model call streaming now: when its first output came and its output tokens so far (the turn's speed). */
  call?: { firstAt: number | null; tokens: number } | null;
  /** The turn in progress (from the first message of a run to its result). */
  turn: { id: string; itemId: Id } | null;
  /** Agent items still streaming, oldest first. */
  streaming: Id[];
  /** Thinking items still streaming, oldest first, with when they started. */
  thinking: Array<{ itemId: Id; startedAt: number }>;
  text: Map<Id, string>;
  /** stream content-block index -> agent item, for the message being streamed */
  blocks: Map<number, Id>;
  /** tool_use id -> tool item */
  tools: Map<string, Id>;
  /** tool_use id -> when the call was made */
  toolStarted: Map<string, number>;
  declinedTools: Set<string>;
  approvals: Map<string, PendingApproval>;
  /** question item id -> the canUseTool call waiting for its answer */
  questions: Map<Id, PendingQuestion>;
  /** AskUserQuestion / ExitPlanMode calls (tool_use id -> name and input), and those that reached the person */
  questionTools: Map<string, { name: string; input: Record<string, unknown> }>;
  askedTools: Set<string>;
  /** Agent tool_use id -> child session */
  subs: Map<string, Id>;
  /** Agent calls running in the background (their tool result arrives at once; a task notification ends them) */
  backgroundSubs: Set<string>;
  /**
   * child session -> the turn item counting its agent's tokens while it runs, and what each model call (message id)
   * added so far (2026-10-17: a subagent's own use, which the parent's turn does not show)
   */
  subUsage: Map<Id, { itemId: Id; rowId?: Id; calls: Map<string, { input: number; cached: number; output: number }> }>;
  // ---- stage 12, S12-E ----
  /** tool_use id -> the call's name and input (kept for the turn: background commands, images read, summaries) */
  calls: Map<string, { name: string; input: Record<string, unknown>; itemId?: Id }>;
  /** CLI task id -> its tool_use id and description (every Bash or agent task, foreground or not) */
  tasks: Map<string, { toolUseId?: string; description: string; type?: string }>;
  /** background command (task id) -> its `background` item */
  bgItems: Map<string, Id>;
  /** The compaction in progress (its item), between status "compacting" and compact_boundary. */
  compaction: Id | null;
  /** A retry is shown on the turn (cleared when the model answers). */
  retrying: boolean;
  /** notice key -> its item, for the turn in progress (repeats update the row instead of adding one) */
  notices: Map<string, Id>;
  /** The command list as the CLI last pushed it (commands_changed), newest first. */
  commands: SdkSlashCommand[] | null;
  /** Tools the person declined in Studio (a permission_denied for them needs no notice). */
  declinedByPerson: Set<string>;
  // ---- stage 15, loop and usage limit (2026-10-16) ----
  /** Background agent id (the CLI's task id) -> its Agent call, to find the child session a SendMessage resumes. */
  agents: Map<string, string>;
  /** SendMessage call that resumed an agent -> its child session (the agent's next task notification names that call). */
  resumes: Map<string, Id>;
  /** The latest rate_limit_event that refused a request (when the limit resets). */
  refused: { resetsAt?: number; type?: string } | null;
  /** This turn stopped at a usage limit: the CLI's text. */
  limitText: string | null;
  /** This turn called ScheduleWakeup (set or stopped the loop). */
  scheduled: boolean;
  /** Who started this turn while a usage limit was pending (for the log: did the CLI go on by itself?). */
  afterLimit: "cli" | "studio" | "person" | null;
  /** The person stopped the loop during this turn: the process closes when the turn ends (taking the CLI's wakeup with it). */
  stopLoopAtEnd: boolean;
  /** The next message is Studio's own (wake), not the person's. */
  sendingForStudio: boolean;
}

/** A process's state before its query is made (`q` is set right after). */
export function newLive(push: Live["push"], end: Live["end"]): Live {
  return {
    q: null as unknown as Query,
    done: Promise.resolve(),
    push,
    end,
    running: false,
    ready: Promise.resolve(),
    interrupted: false,
    givingWay: false,
    capabilities: new Set(),
    mcp: null,
    mcpStale: false,
    undelivered: new Map(),
    atCli: new Set(),
    onAtCli: new Map(),
    closedByHost: false,
    handlerErrors: new Set(),
    background: new Set(),
    idleTimer: null,
    turn: null,
    streaming: [],
    thinking: [],
    text: new Map(),
    blocks: new Map(),
    tools: new Map(),
    toolStarted: new Map(),
    declinedTools: new Set(),
    approvals: new Map(),
    questions: new Map(),
    questionTools: new Map(),
    askedTools: new Set(),
    subs: new Map(),
    backgroundSubs: new Set(),
    subUsage: new Map(),
    calls: new Map(),
    tasks: new Map(),
    bgItems: new Map(),
    compaction: null,
    retrying: false,
    notices: new Map(),
    commands: null,
    declinedByPerson: new Set(),
    agents: new Map(),
    resumes: new Map(),
    refused: null,
    limitText: null,
    scheduled: false,
    afterLimit: null,
    stopLoopAtEnd: false,
    sendingForStudio: false,
  };
}

/** What a running session waits for: an answer, an approval, or nothing. */
export function waitingStatus(live: Live): SessionStatus {
  return live.questions.size ? "awaiting-answer" : live.approvals.size ? "awaiting-approval" : "running";
}
