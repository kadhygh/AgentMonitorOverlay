import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function collabTools({ service, caller, ownTask }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_note_add",
      title: "记进度",
      description: "Add a short progress note to your own AMO task (what was done, what is next, what blocks). The person sees it on the task page. Cannot move the task between board columns.",
      inputSchema: { text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.collab.addTaskNote(ownTask(c), { text: args.text, kind: "progress" }, c.sessionId)),
    },
    {
      name: "handoff_submit",
      title: "提交交接",
      description: "Submit a handoff summary for your own AMO task: what is done, what is left, where the relevant files are, and anything the next session must know.",
      inputSchema: { summary: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.collab.addTaskNote(ownTask(c), { text: args.summary, kind: "handoff" }, c.sessionId)),
    },
    {
      name: "mailbox_send",
      title: "留言",
      description:
        "Leave a message for another AMO session (toSessionId), a task (toTaskId) or a topic (toTopicId); find ids with board_list, task_get, topic_get or session_tree. It does not enter their conversation by itself: the person decides when to forward it, and the recipient can read it with mailbox_read.",
      inputSchema: { toSessionId: z.string().optional(), toTaskId: z.string().optional(), toTopicId: z.string().optional(), text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const to =
            typeof args.toSessionId === "string"
              ? { kind: "session", sessionId: args.toSessionId }
              : typeof args.toTaskId === "string"
                ? { kind: "task", taskId: args.toTaskId }
                : typeof args.toTopicId === "string"
                  ? { kind: "topic", topicId: args.toTopicId }
                  : null;
          if (!to) throw new HostError("bad_request", "give toSessionId, toTaskId or toTopicId");
          const m = service.collab.sendMail(c.sessionId, to, args.text);
          return { id: m.id, to: m.to, state: m.state };
        }),
    },
    {
      name: "checklist_check",
      title: "勾清单",
      description: "Tick (or untick with done=false) a step of your own task's checklist; find the item ids with task_get. The person sees who ticked it.",
      inputSchema: { itemId: z.string(), done: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const item = service.collab.setChecklistDone(String(args.itemId), args.done !== false, c.sessionId);
          return { id: item.id, text: item.text, done: item.done };
        }),
    },
    {
      name: "decision_request",
      title: "请求决策",
      description:
        "Ask the person to decide something you should not decide alone (offer short options when you can). It is shown in the AMO workbench and the Focus window; it does not block your turn. The answer comes back to you as mail (mailbox_read).",
      inputSchema: { question: z.string(), options: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const d = service.collab.requestDecisionFromSession(c.sessionId, args.question, args.options);
          return { id: d.id, state: d.state, note: "The answer will arrive as mail; read it with mailbox_read." };
        }),
    },
    {
      name: "mailbox_read",
      title: "读留言",
      description: "Read the unread messages left for you or for your task or topic (they are then marked read).",
      inputSchema: {},
      readOnly: false,
      autoApprove: true,
      run: () =>
        write(caller, (c) => {
          const title = (id: Id | null) => (id ? service.store.getSession(id)?.title || "会话" : "我（人）");
          return {
            // The text first: it is what the agent needs, the routing is context.
            messages: service.collab.readMailFromSession(c.sessionId).map((m) => ({
              text: m.text,
              from: m.fromSessionId ? { sessionId: m.fromSessionId, title: title(m.fromSessionId), taskId: m.fromTaskId, topicId: m.fromTopicId ?? null } : "person",
              to: m.to,
              at: m.createdAt,
            })),
          };
        }),
    },
  ];
}
