import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { write, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

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
        "A message to another AMO session (toSessionId), a task (toTaskId) or a topic (toTopicId) — find ids with board_list, task_get, topic_get or session_tree — as a message of a 事项 (numbered 「#12」; 事项 「事项 3」). replyTo: the #number of a message you answer — it goes back to whoever sent it, in the same 事项, no address needed, and that message counts as 处理了. matter: write in a 事项 (「事项 3」 or its id) — to its other side when you leave out to*. How it goes in, by distance: in your own task, and to another task of your topic, it goes into their conversation by itself once their turn is over (a task can be set to 先问); to another topic, or without a topic, it waits for the person to send it in. The answer says which (delivered / queued / waiting for the person). While it is still queued you can take it back (withdraw: its #number) or rewrite it (edit: its #number, with the new text); once it went in, send a new one that says it replaces #n.",
      inputSchema: {
        toSessionId: z.string().optional(),
        toTaskId: z.string().optional(),
        toTopicId: z.string().optional(),
        text: z.string().optional(),
        replyTo: z.union([z.string(), z.number()]).optional(),
        matter: z.union([z.string(), z.number()]).optional(),
        withdraw: z.union([z.string(), z.number()]).optional(),
        edit: z.union([z.string(), z.number()]).optional(),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        writeAsync(caller, async (c) => {
          if (args.withdraw === undefined && typeof args.text !== "string") throw new HostError("bad_request", "text is required");
          const m = await service.collab.sendFromSession(c.sessionId, args);
          const matter = m.matter ? service.store.getMatter(m.matter) : undefined;
          const r = m.receipts?.[0];
          const state = m.withdrawnAt !== undefined ? "withdrawn" : m.ask ? "waiting for the person" : r?.state === "queued" && m.state === "forwarded" ? "queued" : r?.state ?? m.state;
          const note =
            m.withdrawnAt !== undefined
              ? `#${m.seq} 已撤回，没有送进去。`
              : m.editedAt && args.edit !== undefined
                ? `#${m.seq} 已改写，送进去的会是新的。`
                : m.ask
                  ? "离得远（别的专题、没有专题，或对方的任务设了先问）：等人在「待我处理」里送进去。"
                  : state === "queued"
                    ? "对方这一轮还没结束：等它停下就送进去。还没送到之前可以撤回（withdraw）或改写（edit）。"
                    : "已送进对方的会话。";
          return { seq: m.seq, matter: matter ? `事项 ${matter.no}「${matter.title}」` : null, matterId: m.matter ?? null, to: m.to, state, note };
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
        "Ask the person to decide something you should not decide alone (offer short options when you can). It is shown in the workbench's question popup and the Focus window; it does not block your turn. While your turn goes on, the answer comes back as mail (mailbox_read); if your turn has ended before the person answers (or you have not read it by then), it comes into this conversation as a message.",
      inputSchema: { question: z.string(), options: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const d = service.collab.requestDecisionFromSession(c.sessionId, args.question, args.options);
          return { id: d.id, state: d.state, note: "During this turn the answer arrives as mail (mailbox_read); after the turn it comes in as a message." };
        }),
    },
    {
      name: "mailbox_read",
      title: "读留言",
      description:
        "Read the messages left for you or for your task or topic that did not come into your conversation by themselves (they are then 看过), and what is still 待你处理: messages to you not yet 处理了 (#number, 事项). handled: the #numbers of messages you are done with (no answer needed), marked 处理了 first — one you answered with replyTo, or after which you wrote in the same 事项, is marked by itself. sent: true also lists your own messages still queued (you can withdraw or edit them with mailbox_send).",
      inputSchema: { handled: z.array(z.union([z.string(), z.number()])).optional(), sent: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const title = (id: Id | null) => (id ? service.store.getSession(id)?.title || "会话" : "我（人）");
          const matterOf = (id: Id | undefined) => {
            const m = id ? service.store.getMatter(id) : undefined;
            return m ? `事项 ${m.no}「${m.title}」` : null;
          };
          const session = service.store.getSession(c.sessionId);
          const handled = args.handled && session ? service.collab.matters.markHandledBy(session, args.handled) : [];
          const read = { messages: service.collab.readMailFromSession(c.sessionId), handled };
          return {
            // The text first: it is what the agent needs, the routing is context.
            messages: read.messages.map((m) => ({
              text: m.text,
              seq: m.seq,
              matter: matterOf(m.matter),
              ...(m.replyTo ? { replyTo: m.replyTo } : {}),
              from: m.fromSessionId ? { sessionId: m.fromSessionId, title: title(m.fromSessionId), taskId: m.fromTaskId, topicId: m.fromTopicId ?? null } : "person",
              to: m.to,
              at: m.createdAt,
            })),
            ...(read.handled.length ? { markedHandled: read.handled.map((n) => `#${n}`) } : {}),
            pending: service.collab.matters.pendingOf(c.sessionId).map((p) => ({ kind: p.kind, matter: matterOf(p.matter ?? undefined), ...(p.seq ? { seq: p.seq } : {}), text: p.text })),
            ...(args.sent ? { queued: service.collab.matters.queuedFrom(c.sessionId).map((m) => ({ seq: m.seq, to: m.to, matter: matterOf(m.matter), text: m.text.slice(0, 200), at: m.createdAt })) } : {}),
          };
        }),
    },
  ];
}
