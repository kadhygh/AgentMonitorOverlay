import type { Id, ModelProfile, QuestionPrompt, Session } from "@amo-studio/protocol";
import type { RuntimeCore } from "../runtime.js";
import type { ServerRequest } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";

// What the Codex runtime keeps per session and per pending request (stage 16 split out of codex-runtime.ts), and what
// its parts (events, asks) use of it.

export interface SessionState {
  activeTurnId: string | null;
  /** codex item id -> our item id */
  items: Map<string, Id>;
  /** streaming text per codex item id (agent messages, reasoning) */
  text: Map<string, string>;
  /** codex turn id -> our turn item id */
  turns: Map<string, Id>;
  /** reasoning items: which stream they show (summary or raw content) and when they started */
  reasoning: Map<string, { channel?: "summary" | "content"; startedAt: number }>;
  /**
   * Turns in review mode (review/start). Their items carry the review's own turn id, which is also what turn/completed
   * names, while turn/started names another one with it as `rootTurnId` (Codex 0.162; spikes/s12-e-codex-cli.mjs).
   */
  reviewTurns: Set<string>;
  /** notice key -> its item, for the turn in progress (repeats update the row) */
  notices: Map<string, Id>;
  /** The turn whose item shows a retry (cleared when the model answers). */
  retrying: string | null;
  /**
   * When the model call streaming now gave its first output (a reasoning or message item, or their text): its end is
   * the token usage it reports; the time between, with its output tokens, is the turn's speed (as DSH measures it).
   */
  callFirstAt: number | null;
}

export function newSessionState(): SessionState {
  return { activeTurnId: null, items: new Map(), text: new Map(), turns: new Map(), reasoning: new Map(), reviewTurns: new Set(), notices: new Map(), retrying: null, callFirstAt: null };
}

export interface PendingApproval {
  /** `elicitation`: an MCP server asking before a tool runs (answered with an action, not a decision). */
  kind: "approval" | "elicitation";
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
}

/** request_user_input or an MCP form waiting for the person (a `question` item). */
export interface PendingQuestion {
  kind: "input" | "form";
  sessionId: Id;
  itemId: Id;
  profileId: string;
  requestId: ServerRequest["id"];
  questions: QuestionPrompt[];
}

export type ThreadLike = { id: string; forkedFromId?: string | null; parentThreadId?: string | null; modelProvider?: string };

export const ELICITATION = "mcpServer/elicitation/request";
export const USER_INPUT = "item/tool/requestUserInput";
export const isApprovalMethod = (method: string) => method.endsWith("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval" || method === ELICITATION;

export const approvalKey = (sessionId: Id, approvalId: string) => `${sessionId}:${approvalId}`;

/** The turn a turn event belongs to: a review's follow-up turn counts as the review's own (see reviewTurns). */
export function turnKey(st: { reviewTurns: Set<string> }, turn: { id: string; rootTurnId?: string | null }): string {
  return turn.rootTurnId && turn.rootTurnId !== turn.id && st.reviewTurns.has(turn.rootTurnId) ? turn.rootTurnId : turn.id;
}

/** What the parts of the Codex runtime (stage 16: events, asks) use of it. */
export interface CodexCore extends RuntimeCore {
  sessionState(id: Id): SessionState;
  /** The session's state if it has any yet (never made by asking). */
  knownState(id: Id): SessionState | undefined;
  /** The session whose thread this is. */
  findByThread(threadId: string): Session | undefined;
  handleFor(profileId: Id): Promise<CodexServerHandle>;
  profile(id: Id): ModelProfile;
}
