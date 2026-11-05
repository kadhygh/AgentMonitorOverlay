import { randomBytes } from "node:crypto";
import type { Id } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";
import type { CodexConfig } from "../runtime/profiles.js";
import { MCP_SESSION_PREFIX, MCP_TOKEN_PREFIX } from "../store/kv-keys.js";

// Who is calling the AMO MCP. A Codex thread sends its own token in a header that Studio set at thread/start (and sets
// again on resume and fork); the Host maps the token back to the session. Tokens are kept in the store so an app-server
// adopted after a Host restart, whose threads still carry the old headers, is still recognised.

export const MCP_SESSION_HEADER = "X-AMO-Session-Token";

const byToken = (token: string) => MCP_TOKEN_PREFIX + token;
const bySession = (sessionId: Id) => MCP_SESSION_PREFIX + sessionId;

export class McpIdentities {
  constructor(private readonly store: Store) {}

  /** A new token, not yet tied to a session (a thread is started before Studio knows its session id). */
  issue(): string {
    return randomBytes(24).toString("hex");
  }

  bind(token: string, sessionId: Id): void {
    this.store.setKv(byToken(token), sessionId);
    this.store.setKv(bySession(sessionId), token);
  }

  /** The session's token, created on first use (sessions from before stage 5 have none yet). */
  tokenFor(sessionId: Id): string {
    const known = this.store.getKv(bySession(sessionId))?.value;
    if (known) return known;
    const token = this.issue();
    this.bind(token, sessionId);
    return token;
  }

  sessionFor(token: string | null | undefined): Id | null {
    if (!token) return null;
    const id = this.store.getKv(byToken(token))?.value;
    return id && this.store.getSession(id) ? id : null;
  }

  /** Thread config that makes the AMO MCP send this token. */
  static threadConfig(token: string): CodexConfig {
    return { "mcp_servers.amo.http_headers": { [MCP_SESSION_HEADER]: token } };
  }
}
