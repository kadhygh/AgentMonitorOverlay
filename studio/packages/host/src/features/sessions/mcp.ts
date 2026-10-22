import { z } from "zod";
import { answer, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function sessionsTools({ service, caller, model }: ToolContext): AmoTool[] {
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
    {
      name: "session_start",
      title: "开会话",
      description:
        "Start another main session in your own task, at once (no approval), to work on a part in parallel or with a fresh context. text: its first message — enough to work on its own. model: a model's name or id from amo_whoami (default yours) — e.g. a cheaper one to carry out a detailed plan of yours. title: its name in the session list (optional). report: true when you need its result — when its first turn ends, its last reply comes back into your conversation as a message; leave it out when you do not. It shows under you in the task's session list, where the person can watch or stop it; it is archived on its own. For another task use relay_send (主控) or mailbox_send.",
      inputSchema: { text: z.string(), model: z.string().optional(), title: z.string().optional(), report: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        writeAsync(caller, async (c) => {
          const s = await service.sessions.startPeer(c.sessionId, args);
          return { sessionId: s.id, title: s.title, model: service.requireProfile(s.profileId).label, report: args.report === true, note: args.report === true ? "已开会话；它这一轮做完后，回复会作为消息回到你这里。" : "已开会话；它在任务的会话列表里。" };
        }),
    },
  ];
}
