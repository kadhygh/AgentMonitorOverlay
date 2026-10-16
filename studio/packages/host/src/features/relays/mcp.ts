import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function relaysTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "relay_send",
      title: "传话",
      description:
        "主控 only: say something in another task's session of your topic (of your project when you are in none) — a decision, a change of plan, what to do next. The person confirms it first, unless that task takes relays without asking; then it goes into the task's latest main session (queued while it works), or starts one. It arrives marked as from you, with how to answer (mailbox_send). How it went comes back as mail. For a note the task may read when it likes, use mailbox_send instead.",
      inputSchema: { taskId: z.string(), text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const relay = service.relays.send(c.sessionId, args);
          const auto = service.store.getTask(relay.toTaskId)?.relayAuto;
          return { relayId: relay.id, note: auto ? "这个任务的传话不用确认：正在送进它的会话。" : "等人确认后送进它的会话；结果会作为留言回来（mailbox_read）。" };
        }),
    },
  ];
}
