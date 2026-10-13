import { z } from "zod";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function sessionsTools({ model }: ToolContext): AmoTool[] {
  return [
    {
      name: "session_tree",
      title: "会话树",
      description: "A task's sessions as a tree (main sessions, branches, subagents) with an excerpt of each one's latest reply.",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.sessionTree(String(args.taskId))),
    },
  ];
}
