import { z } from "zod";
import { answer, write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { noteOwnDescription } from "../guide/role.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function tasksTools({ service, caller, model, ownTask, inOwnTopic }: ToolContext): AmoTool[] {
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
    {
      name: "task_describe",
      title: "任务说明",
      description:
        "Write a task's description: what it is about, its goal and scope, in a few lines. It shows on the task's canvas card and task page, for the person and other agents. Your own task when taskId is left out; otherwise a task of your topic. An empty description removes it.",
      inputSchema: { taskId: z.string().optional(), description: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const taskId = args.taskId === undefined ? ownTask(c) : String(args.taskId);
          if (args.taskId !== undefined && taskId !== service.store.getSession(c.sessionId)?.taskId) inOwnTopic(c, taskId);
          const task = service.tasks.updateTask(taskId, { description: args.description });
          if (taskId === service.store.getSession(c.sessionId)?.taskId) noteOwnDescription(service, c.sessionId);
          return { taskId: task.id, description: task.description ?? "" };
        }),
    },
  ];
}
