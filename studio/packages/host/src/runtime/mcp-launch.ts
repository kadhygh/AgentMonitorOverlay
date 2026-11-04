import type { McpServerSpec } from "@amo-studio/protocol";

// MCP 设置 (2026-11-04, plans/mcp.md): what a runtime starts a session's process with besides `amo`. Worked out by the
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
