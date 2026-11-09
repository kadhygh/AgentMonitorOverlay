import type { McpServerSpec } from "@amo-studio/protocol";

// MCP 设置 (2026-11-04, plans/done/mcp.md): what a runtime starts a session's process with besides `amo`. Worked out by the
// MCP feature (features/mcp/service.ts launch); here so the runtimes need not import a feature.

export interface McpLaunch {
  /** Servers passed to the CLI explicitly, secrets filled in. */
  explicit: Record<string, McpServerSpec>;
  /** Claude in the person's own config dir: the CLI loads their servers itself; these names are denied to it. */
  deny: string[];
  /** Claude, same: .mcp.json servers approved for this process. */
  enableJson: string[];
  /** Claude: load only the explicit ones (strictMcpConfig). */
  strict: boolean;
}

/** A session not made yet: its project and its own choices. */
export interface McpDraft {
  workspaceId: string;
  mcp?: Record<string, boolean>;
}

/** What a runtime asks the MCP feature. `native`: Claude in the person's own config dir (see launch). */
export interface McpSource {
  /** For a session, or one about to be made (DSH asks before the session exists). */
  launch(target: string | McpDraft, native: boolean): McpLaunch;
  /** Claude: the statuses its process reported. */
  noteStatus?(sessionId: string, list: ReadonlyArray<{ name: string; status: string; source?: string; error?: string }>): void;
}

const sorted = (xs: readonly string[]) => [...xs].sort().join("\n");

/** Whether two launches differ in what only a new process can take (Claude: strict, denied and approved names). */
export function sameProcessPart(a: McpLaunch, b: McpLaunch): boolean {
  return a.strict === b.strict && sorted(a.deny) === sorted(b.deny) && sorted(a.enableJson) === sorted(b.enableJson);
}

/** A spec as the Claude Agent SDK's mcpServers takes it. */
export function sdkServer(spec: McpServerSpec): Record<string, unknown> {
  if (spec.type === "stdio") return { type: "stdio", command: spec.command ?? "", ...(spec.args?.length ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) };
  return { type: spec.type, url: spec.url ?? "", ...(spec.headers ? { headers: spec.headers } : {}) };
}

/** A spec as ACP's session/new and session/resume take it (DSH). */
export function acpServer(name: string, spec: McpServerSpec): Record<string, unknown> {
  if (spec.type === "stdio") return { name, command: spec.command ?? "", args: spec.args ?? [], env: Object.entries(spec.env ?? {}).map(([k, value]) => ({ name: k, value })) };
  return { type: spec.type, name, url: spec.url ?? "", headers: Object.entries(spec.headers ?? {}).map(([k, value]) => ({ name: k, value })) };
}

/**
 * The connections an agent takes besides a program of its own (stdio, which every one takes): ACP's
 * agentCapabilities.mcpCapabilities (DSH 2026-11: http only), or what Codex's config has (stdio and http).
 */
export interface McpTransports {
  http: boolean;
  sse: boolean;
}

/** Whether the agent can take this server as it is. */
export const mcpFits = (spec: McpServerSpec, t: McpTransports): boolean => spec.type === "stdio" || (spec.type === "http" && t.http) || (spec.type === "sse" && t.sse);

const TRANSPORT_LABEL: Record<string, string> = { http: "HTTP", sse: "SSE" };

/**
 * What a session is told when MCP servers that are on could not go with it (2026-11-09, the user: 有人用子会话拉起
 * DeepSeek 会话，因为项目里一个 SSE 的 MCP 整个起不来 — 不应当要人去关掉项目里指定的 MCP，应该在子会话里去处理).
 */
export function mcpSkippedNotice(skipped: ReadonlyArray<McpSkipped>, runtime: string): string {
  const parts: string[] = [];
  const transport = skipped.filter((s) => s.failed === undefined);
  if (transport.length) {
    const names = transport.map((s) => `${s.name}（${TRANSPORT_LABEL[s.type] ?? s.type} 连接）`).join("、");
    parts.push(`这个会话没带上 MCP：${names}。${runtime} 不支持这种连接方式，其他 MCP 照常可用；要在 ${runtime} 会话里用它，得换成 HTTP 连接的地址，或在 Claude 会话里用。`);
  }
  // 2026-11-09 (ybf's report): DSH could not connect to Figma's MCP and refused the whole session with「Internal error」.
  // Figma's wants OAuth, which Claude Code goes through and DSH does not; the cause is not certain, so it is a "maybe".
  const failed = skipped.filter((s) => s.failed !== undefined);
  if (failed.length) {
    const names = failed.map((s) => (s.failed ? `${s.name}（${s.failed}）` : s.name)).join("、");
    parts.push(`这个会话没带上 MCP：${names}。${runtime} 连不上它，其他 MCP 照常可用。常见原因是这个服务要登录（比如 Figma 要 OAuth），${runtime} 会话不会走登录；不用它就在会话顶上的 MCP 里关掉，要用就在 Claude 会话里用。`);
  }
  return parts.join("\n");
}

/** A server that did not go with a session: its transport is not taken, or (failed) the agent could not connect to it. */
export interface McpSkipped {
  name: string;
  type: string;
  /** The agent's own words for why it could not connect ("" when it said nothing more). */
  failed?: string;
}
