import { z } from "zod";
import { TASK_PLAN_MAX_TASKS } from "@amo-studio/protocol";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function taskPlansTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_plan_propose",
      title: "拆任务提案",
      description: `主控 only: propose splitting the work into tasks (at most ${TASK_PLAN_MAX_TASKS}). Nothing is made until the person accepts it on the topic's canvas, possibly after changing it; then each task is made in its project with its description, put on the canvas with its dependencies (a group per project when they span several), and started with its first message or left in 待办. The decision comes back to you as mail (mailbox_read), with the new tasks' ids. Per task: key (for dependsOn, default t1, t2…), title, project (id or name; default your own), description (what it is about, its goal and scope), firstMessage (what its session is told first: enough to work on its own), model (a model's name or id from amo_whoami; default yours), dependsOn (keys that must finish first).`,
      inputSchema: {
        summary: z.string(),
        tasks: z.array(
          z.object({
            key: z.string().optional(),
            title: z.string(),
            project: z.string().optional(),
            description: z.string().optional(),
            firstMessage: z.string().optional(),
            model: z.string().optional(),
            dependsOn: z.array(z.string()).optional(),
          }),
        ),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const plan = service.taskPlans.propose(c.sessionId, args);
          return { proposalId: plan.id, tasks: plan.tasks.length, note: "提案已交给人确认；结果会作为留言回来（mailbox_read）。" };
        }),
    },
  ];
}
