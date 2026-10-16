import type { Id, Session } from "@amo-studio/protocol";
import type { RuntimeCore } from "../runtime.js";
import type { ClaudeHome } from "./claude-env.js";
import type { Live } from "./live.js";

/**
 * What the parts of the Claude runtime (stage 16: messages, turns, subagents, asks, wake, usage) use of it: the
 * shared persistence helpers, the running processes and the few operations they start themselves.
 */
export interface ClaudeCore extends RuntimeCore {
  /** The running Claude Code process per session. */
  readonly live: Map<Id, Live>;
  /** Processes being closed: a new one for the same session waits for it. */
  readonly closing: Map<Id, Promise<void>>;
  /** The config dir a session runs in (its transcript is there). */
  homeOf(sessionId: Id): ClaudeHome;
  /** The session's project folder. */
  cwdOf(sessionId: Id): string | undefined;
  ensureLive(session: Session): Live;
  sendMessage(sessionId: Id, text: string): Promise<unknown>;
  close(sessionId: Id): Promise<void>;
  clearIdle(live: Live): void;
}
