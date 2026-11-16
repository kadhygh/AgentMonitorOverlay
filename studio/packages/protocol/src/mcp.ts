import type { Id, Timestamp } from "./entities.js";

// MCP 设置 (2026-11-04, plans/done/mcp.md): which MCP servers sessions get, besides Studio's own `amo`. Three levels decide
// whether one is on — the session's choice, then its project's, then the global one, then the server's default — and
// the person's own Claude Code config (~/.claude.json, a project's .mcp.json) is read when 「加载本机已配置的 MCP」 is on.

/** A server's connection, as an `mcpServers` entry of Claude Code / .mcp.json has it. */
export interface McpServerSpec {
  type: "stdio" | "http" | "sse";
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
}

/** What the Host shows instead of a stored secret (an env or header value); sending it back keeps the stored one. */
export const MCP_SECRET_MASK = "••••••";

/** Studio's own name for its MCP: never one of the person's. */
export const AMO_MCP_SERVER_NAME = "amo";

/** Names of the person's servers that are off unless turned on (the user, 2026-11-04: amo-relay duplicates team_ask). */
export const MCP_OFF_BY_DEFAULT: Record<string, string> = {
  "amo-relay": "和 Studio 自带的中转（team_ask）重复，默认不启用",
};

export const MCP_LIMITS = { servers: 50, name: 64 } as const;

/** A server kept by Studio (设置 → MCP, or an agent's mcp_server_save the person approved). */
export interface StudioMcpServer {
  id: Id;
  name: string;
  /** env and header values are MCP_SECRET_MASK in what the Host returns. */
  spec: McpServerSpec;
  /** On by default everywhere (projects and sessions may still turn it off). */
  on: boolean;
  /** "" when none. */
  note: string;
  by: "person" | "agent";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Where a server comes from: `studio` (设置 → MCP), `user` (~/.claude.json mcpServers), `local` (~/.claude.json, this
 * project's entry — `claude mcp add`'s default), `project` (the project's .mcp.json), `seen` (only reported by a Claude
 * session: a plugin's, a claude.ai connector…).
 */
export type McpSource = "studio" | "user" | "local" | "project" | "seen";

export const MCP_SOURCE_LABELS: Record<McpSource, string> = {
  studio: "Studio",
  user: "本机 · 用户级",
  local: "本机 · 这个项目",
  project: "项目 .mcp.json",
  seen: "会话里见过",
};

/** The last state a Claude session reported for a server. */
export interface McpServerStatusSeen {
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | string;
  error?: string;
  /** Where Claude Code said it came from (user, project, local, plugin, claudeai…). */
  source?: string;
  at: Timestamp;
}

/** One server as a level (global, a project, a session) sees it. */
export interface McpEntry {
  name: string;
  source: McpSource;
  /** stdio: the command line; http/sse: the address. No secrets. */
  summary: string;
  type?: McpServerSpec["type"];
  /** Studio's server id (source studio). */
  serverId?: Id;
  /** On where this was asked for (session, project or global). */
  on: boolean;
  /** What it would be without this level's own choice. */
  inherited: boolean;
  /** This level's own choice, if it made one. */
  choice?: boolean;
  /** Why it is off by default, or other things worth knowing (e.g. not approved in Claude Code yet). */
  note?: string;
  status?: McpServerStatusSeen;
}

/** 设置 → MCP. */
export interface McpState {
  /** 加载本机已配置的 MCP (default on). */
  loadLocal: boolean;
  servers: StudioMcpServer[];
  /** Every server at the global level: Studio's, the person's user-level ones and those seen in sessions. */
  entries: McpEntry[];
  /** The Claude Code config file read for the person's own servers. */
  claudeConfig: string;
}

/** A project's MCP (编辑项目): the global ones plus its own .mcp.json and ~/.claude.json entry. */
export interface McpProjectState {
  workspaceId: Id;
  loadLocal: boolean;
  entries: McpEntry[];
}

/** When a change of a session's MCP reaches it. */
export type McpApply = "now" | "next-message" | "after-turn" | "codex-restart" | "not-running";

/** A session's MCP (the composer's 「MCP」 button). */
export interface McpSessionState {
  sessionId: Id;
  runtime: string;
  loadLocal: boolean;
  entries: McpEntry[];
  /** Codex: per-session choices do not apply (its servers are fixed when its app-server starts). */
  perSession: boolean;
  /** Claude: whether the statuses are from its running process just now. */
  live: boolean;
  /** A remote task's copy (2026-11-17): the computer it runs on does not let devices pick its MCP — why (McpOffer.locked). */
  locked?: string;
}

/**
 * 选 MCP (2026-11-17): one MCP server as a new session's setup offers it (新任务, 新会话, 分支, here or on a paired device)
 * — what the person picks by: its name, where it comes from, the note, whether it is on. Nothing to run it with (no
 * command, address, env or header), so the same list can go to another computer.
 */
export interface McpOfferEntry {
  name: string;
  source: McpSource;
  note?: string;
  /** On for the session (asked) or for a new one by default. */
  on: boolean;
  /** A session's: what it would be without the session's own choice, and that choice. */
  inherited?: boolean;
  choice?: boolean;
}

/** What a new session (or a session) may pick from (2026-11-17). */
export interface McpOffer {
  entries: McpOfferEntry[];
  /** false: Codex — its MCP is fixed when its app-server starts, nothing to pick per session (the list is to read). */
  perSession: boolean;
  /** A change (PUT): when it reaches the session. */
  apply?: McpApply;
  /**
   * A paired device's list of another computer's (2026-11-17): that computer's 远程设置 does not let devices pick its MCP —
   * why, said so; the list is to read and sessions get that computer's defaults.
   */
  locked?: string;
}

/** `PUT` bodies: a name's choice, true/false, or null to follow the level above. */
export type McpChoices = Record<string, boolean | null>;

export interface NewStudioMcpServer {
  name: string;
  spec: McpServerSpec;
  on?: boolean;
  note?: string;
}

export interface StudioMcpServerPatch {
  name?: string;
  spec?: McpServerSpec;
  on?: boolean;
  note?: string;
}

/** The command line or address of a spec, without secrets. */
export function mcpSummary(spec: McpServerSpec): string {
  if (spec.type === "stdio") return [spec.command ?? "", ...(spec.args ?? [])].filter(Boolean).join(" ");
  return spec.url ?? "";
}

// ---- Host routes (declared here, part of api.ts's HostRoutes) --------------------------------------------------

/** MCP 设置 (2026-11-04, plans/done/mcp.md). */
export interface McpRoutes {
  "GET /api/mcp": { req: void; res: McpState };
  "PUT /api/mcp": { req: { loadLocal?: boolean; choices?: McpChoices }; res: McpState };
  "POST /api/mcp/servers": { req: NewStudioMcpServer; res: StudioMcpServer };
  "PATCH /api/mcp/servers/:id": { req: StudioMcpServerPatch; res: StudioMcpServer };
  "DELETE /api/mcp/servers/:id": { req: void; res: { ok: true } };
  "GET /api/mcp/projects/:id": { req: void; res: McpProjectState };
  "PUT /api/mcp/projects/:id": { req: { choices: McpChoices }; res: McpProjectState };
  "GET /api/sessions/:id/mcp": { req: void; res: McpSessionState };
  /**
   * 新会话 / 新任务 (2026-11-17): what a new session would have — `?profile=` (its model), `&task=` (a task's: its project,
   * and its latest session's choices as a new session inherits them) or `&workspace=` (a new task's project; none: the
   * common folder).
   */
  "GET /api/mcp/offer": { req: void; res: McpOffer };
  /** `apply`: when the change reaches the session. */
  "PUT /api/sessions/:id/mcp": { req: { choices: McpChoices }; res: McpSessionState & { apply: McpApply } };
}
