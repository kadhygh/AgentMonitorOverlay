import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function relaysTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_message",
      title: "传话",
      description:
        "主控 only: say something in another task's session of your topic (of your project when you are in none) — a decision, a change of plan, what to do next. It opens a 事项 (kind: delegate 委派 — the default, you wait for its result — or notice 通知, only to inform) whose first message it is (「#12」). To a task of your topic it goes in by itself (into the task's latest main session once its turn is over, or a new one), unless that task is set to 先问; to a task only referenced on your canvas, or in a project without topic, the person confirms it first. Their answer comes back to you by itself, in the same 事项: what they send with mailbox_send replyTo, and for a 委派 the reply of the turn that read it. While it waits you can take it back or rewrite it (mailbox_send withdraw / edit with its #number).",
      inputSchema: { taskId: z.string(), text: z.string(), kind: z.enum(["delegate", "notice"]).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const relay = service.relays.send(c.sessionId, args);
          const auto = service.relays.goesAtOnce(c.sessionId, relay.toTaskId);
          const mail = relay.mailId ? service.store.getMail(relay.mailId) : undefined;
          const matter = mail?.matter ? service.store.getMatter(mail.matter) : undefined;
          return {
            relayId: relay.id,
            ...(mail?.seq ? { seq: mail.seq } : {}),
            ...(matter ? { matter: `事项 ${matter.no}「${matter.title}」`, matterId: matter.id } : {}),
            note: auto
              ? `正在送进它的会话（它这一轮做完再送）。${relay.kind === "notice" ? "" : "它的回话和这一轮的结果会自动回到你这里，在同一件事项里；"}只剩等结果时就结束这一轮，不用轮询。`
              : "离得远（不在同一个专题，或那个任务设了先问）：等人确认后送进它的会话。回话会自动回到你这里。",
          };
        }),
    },
  ];
}
