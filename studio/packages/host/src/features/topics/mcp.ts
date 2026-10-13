import { z } from "zod";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function topicsTools({ model }: ToolContext): AmoTool[] {
  return [
    {
      name: "topic_list",
      title: "专题",
      description: "Topics (专题): each groups tasks, possibly across projects, on its own canvas and has its own coordinating sessions. Archived topics are left out.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => answer(() => model.topicList()),
    },
    {
      name: "topic_get",
      title: "专题详情",
      description: "One topic (id or title; your own topic when omitted): its projects, its tasks with status, its own sessions with an excerpt of their latest reply, and its canvas as an outline.",
      inputSchema: { topic: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.topicGet(args.topic === undefined ? undefined : String(args.topic))),
    },
  ];
}
