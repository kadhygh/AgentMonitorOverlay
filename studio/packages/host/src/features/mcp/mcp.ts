import { z } from "zod";
import { MCP_SOURCE_LABELS, type McpEntry } from "@amo-studio/protocol";
import { answer, fail, json, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";

/** An entry as an agent reads it. */
const shown = (e: McpEntry) => ({
  name: e.name,
  from: MCP_SOURCE_LABELS[e.source],
  ...(e.summary ? { runs: e.summary } : {}),
  on: e.on,
  ...(e.note ? { note: e.note } : {}),
  ...(e.status ? { lastStatus: e.status.status, ...(e.status.error ? { error: e.status.error } : {}) } : {}),
});

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function mcpTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "mcp_server_list",
      title: "MCP 列表",
      description:
        "The MCP servers Studio gives sessions besides amo (设置 → MCP): Studio's own, the person's Claude Code ones (~/.claude.json, a project's .mcp.json) and ones seen in Claude sessions, with whether each is on in your session and its last known status. No secrets. To connect a new one, use mcp_server_save.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: async () => {
        if (!caller) return answer(() => service.mcp.state().entries.map(shown));
        try {
          const s = await service.mcp.session(caller.sessionId);
          return json({ yourSession: { runtime: s.runtime, perSession: s.perSession }, servers: s.entries.map(shown) });
        } catch (err) {
          if (err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "mcp_server_save",
      title: "接入 MCP",
      description: [
        "When the person asks to connect an MCP server: add it to Studio (no id) or change one of Studio's (id from 设置 → MCP / mcp_server_list's Studio entries). The person approves each save, seeing what it runs.",
        'config: the server\'s entry as in Claude Code\'s mcpServers — {"command":"npx","args":["-y","pkg"],"env":{…}} for a program on this computer, {"type":"http","url":"https://…","headers":{…}} (or "sse") for a remote one. Look its setup up in the server\'s own docs.',
        "Never put a key or token in it yourself: give the env or header name with an empty value and tell the person to fill it in at 设置 → MCP.",
        "on (default true): on in every session unless a project or session turns it off. enableHere: also turn it on in your own session — a Claude session gets it from its next tool call, DeepSeek from your next message; Codex takes Studio's servers only when its app-server next starts.",
      ].join(" "),
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        on: z.boolean().optional(),
        note: z.string().optional(),
        enableHere: z.boolean().optional(),
      },
      readOnly: false,
      autoApprove: false,
      run: async (args) => {
        if (!caller && args.enableHere) return fail("这次调用没有 AMO 会话身份，enableHere 用不了。");
        try {
          const body = { ...(args.name !== undefined ? { name: args.name } : {}), ...(args.config !== undefined ? { spec: args.config } : {}), ...(args.on !== undefined ? { on: args.on } : {}), ...(args.note !== undefined ? { note: args.note } : {}) };
          const server = args.id === undefined ? service.mcp.create(body, "agent") : service.mcp.update(String(args.id), body, "agent");
          const missing = [...Object.entries(server.spec.env ?? {}), ...Object.entries(server.spec.headers ?? {})].filter(([, v]) => !v).map(([k]) => k);
          const here = args.enableHere && caller ? await service.mcp.enableFor(caller.sessionId, server.name) : null;
          return json({
            saved: { id: server.id, name: server.name, on: server.on },
            ...(missing.length ? { toFill: `这些值是空的，请人到 设置 → MCP 里填：${missing.join("、")}` } : {}),
            ...(here ? { yourSession: here === "now" ? "已在你的会话里启用：下一次调用工具时就能用" : here === "next-message" || here === "after-turn" ? "已在你的会话里启用：从人的下一条消息起可用" : "Codex 会话要等它的 app-server 下次启动" } : {}),
          });
        } catch (err) {
          if (err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
  ];
}

