import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts): schedule_propose, for the scheduler's own sessions only. */
export function planningTools({ service, caller }: ToolContext): AmoTool[] {
  if (!caller || !service.planning.isSchedulerSession(caller.sessionId)) return [];
  return [
    {
      name: "schedule_propose",
      title: "调度提案",
      description:
        "Propose starting work on a whole-picture todo: which workspace (id), which model (profileId), the new session's first message (prompt) and why now (reason). Nothing starts until the person approves; at most 3 proposals per round.",
      inputSchema: { todoId: z.string(), workspace: z.string().optional(), profileId: z.string(), prompt: z.string(), reason: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const p = service.planning.propose({ todoId: args.todoId, workspaceId: args.workspace, profileId: args.profileId, prompt: args.prompt, reason: args.reason }, c.sessionId);
          return { id: p.id, state: p.state, note: "Waiting for the person to approve on the board." };
        }),
    },
  ];
}
