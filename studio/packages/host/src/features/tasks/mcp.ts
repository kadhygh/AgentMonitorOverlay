import { z } from "zod";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function tasksTools({ model }: ToolContext): AmoTool[] {
  return [
    {
      name: "board_list",
      title: "看板",
      description: "Tasks on the AMO board (most recently active first, archived ones left out) with their column, status, project and topic. Filter by project (id or name), topic (id or title) or column.",
      inputSchema: { workspace: z.string().optional(), topic: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.boardList(args as { workspace?: string; topic?: string; column?: "todo" | "doing" | "review" | "done" })),
    },
    {
      name: "task_get",
      title: "任务详情",
      description: "One task: its latest handoff summary, column, status, project, topic, the tasks it depends on and that depend on it, its canvas group, recent progress notes and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.taskGet(String(args.taskId))),
    },
  ];
}
