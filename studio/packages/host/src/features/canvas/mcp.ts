import { z } from "zod";
import { HostError } from "../../core/shared.js";
import { NotFoundError } from "../../mcp/read-model.js";
import { write, fail, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function canvasTools({ service, caller, model, ownTopic, inOwnTopic }: ToolContext): AmoTool[] {
  return [
    {
      name: "canvas_read",
      title: "画布",
      description: "A topic's canvas as structure, without coordinates (your own topic's when no topic id or title is given): groups with their tasks and notes, ungrouped items, tasks not placed yet, and dependencies. Returns a readable outline and the same data as JSON.",
      inputSchema: { topic: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => {
        try {
          const { outline, json: data } = model.canvasRead(args.topic === undefined ? undefined : String(args.topic));
          return { content: [{ type: "text", text: outline }, { type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          if (err instanceof NotFoundError || err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "canvas_group_create",
      title: "画布建组",
      description: "Create a group on your topic's canvas (optionally bound to a project, by id or name). Studio places it; the person approves first.",
      inputSchema: { title: z.string(), workspace: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvases.canvasCreateGroup(ownTopic(c), args)),
    },
    {
      name: "canvas_depend",
      title: "画布连依赖",
      description: "Record on your topic's canvas that toTaskId depends on fromTaskId (fromTaskId must finish first); both must be tasks of your topic. Refused if it would make a cycle. The person approves first.",
      inputSchema: { fromTaskId: z.string(), toTaskId: z.string() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.fromTaskId, args.toTaskId), service.canvases.canvasAddDependency(args.fromTaskId, args.toTaskId))),
    },
    {
      name: "canvas_place",
      title: "画布归组",
      description: "Put a task of your topic into a group on its canvas (groupId), or take it out of its group (omit groupId). Studio picks the position; the person approves first.",
      inputSchema: { taskId: z.string(), groupId: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.taskId), service.canvases.canvasPlaceTask(args.taskId, args.groupId ?? null))),
    },
  ];
}
