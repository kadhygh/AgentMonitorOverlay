import { z } from "zod";
import { answer, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { dshPermissionMode } from "../../runtime/choices.js";

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
        "Start another main session in your own task, at once (no approval), to work on a part in parallel or with a fresh context. text: its first message — enough to work on its own. model: a model's name or id from amo_whoami (default yours), or '<that name>/<one of its models>' for a particular model of it — e.g. a cheaper one to carry out a detailed plan of yours. title: its name in the session list (optional). report: true when you need its result — each time one of its turns ends, its last reply comes back into your conversation as a message (or that the person stopped it, or its error); leave it out when you do not. workspace: another project to work in (its name, id or path from project_context) when the work is not in the task's own folder; it stays a session of your task. permission: read-only, write (its folder, asking beyond it) or full (no sandbox, no approvals — for long runs of commands); the model's default when left out. effort: its reasoning effort (low, medium, high, xhigh, max… — which ones depends on the model; a wrong one is refused with the list); the person's default when left out. It shows under you in the task's session list, where the person can watch or stop it; it is archived on its own. forPerson: true when the person asks for a session they will work in themselves (\"另起一个 session，我来处理…\"): it stands beside you in the list like one they opened, Focus tells them when it waits, and nothing comes back to you (no report). For another task use relay_send (主控) or mailbox_send.",
      inputSchema: { text: z.string(), model: z.string().optional(), title: z.string().optional(), report: z.boolean().optional(), workspace: z.string().optional(), permission: z.enum(["read-only", "write", "full"]).optional(), effort: z.string().optional(), forPerson: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        writeAsync(caller, async (c) => {
          const s = await service.sessions.startPeer(c.sessionId, args);
          // A DeepSeek · DSH session sandboxed to its folder, where the folder is not set up for it (2026-10-23).
          const folder = s.runtime === "dsh" && dshPermissionMode(s.options.permission) === "workspace-write" ? await service.dsh.folder(s.workspaceId).catch(() => null) : null;
          const sandbox =
            folder && folder.state !== "ready"
              ? "这个项目还没为 DSH 的「工作区可写」沙箱设置过权限：它的命令可能一条条要人批准，项目里的 exe 也会降级运行。要跑很多命令就用 permission: full 重开；要沙箱就请人在 设置 → 项目与目录 → DSH 沙箱权限 里设置。"
              : null;
          return { sessionId: s.id, title: s.title, model: s.options.model ? `${service.requireProfile(s.profileId).label}/${s.options.model}` : service.requireProfile(s.profileId).label, project: service.store.getWorkspace(s.workspaceId)?.name, permission: s.options.permission ?? "default", effort: s.options.effort ?? "default", report: args.report === true, note: args.forPerson === true ? "已开会话，给人自己推进：它和你平级列在任务的会话列表里，结果不回到你这里。" : args.report === true ? "已开会话；它每一轮做完后，回复会作为消息回到你这里（被人停下或出错也会告诉你）。" : "已开会话；它在任务的会话列表里。", ...(sandbox ? { sandbox } : {}) };
        }),
    },
  ];
}
