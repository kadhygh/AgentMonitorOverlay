import { z } from "zod";
import { DUTY_DONE_MARK, type DutyItem, type DutyItemInput } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/**
 * The AMO MCP tools of 值守 (gathered in mcp/tools.ts; the user, 2026-10-31): an agent the person asks ("写个脚本，每
 * 30 分钟跑一次，有问题就拉起 AI，没问题了就停") sets an item up and turns it off when the watch is done. Saving waits
 * for the person's approval — an item runs commands and starts sessions on its own, also while nobody watches;
 * turning one off does not.
 */
export function dutyTools({ service, caller }: ToolContext): AmoTool[] {
  const duty = service.duty;
  const shown = (item: DutyItem) => {
    const run = duty.runs().find((r) => r.itemId === item.id);
    const next = duty.state().next[item.id];
    return { ...item, lastRun: run ? { at: run.startedAt, ok: run.ok, skipped: run.skipped ?? false, summary: run.summary } : null, nextRun: next ?? null };
  };
  return [
    {
      name: "duty_list",
      title: "值守项",
      description: "The person's 值守 items (设置 → 值守): what runs when, its last run and the next; and the checks (Studio 自带检查) a session item can run first.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => answer(() => ({ items: duty.items().map(shown), checks: duty.state().checks })),
    },
    {
      name: "duty_save",
      title: "设值守项",
      description: [
        "Only when the person asks: add a 值守 item (no id; title, schedule and action) or change one (id). The person approves each save. It runs on its own from then on; it is on unless enabled=false.",
        'schedule: {"every": seconds (at least 10)} or {"daily": "HH:MM"}.',
        'action: {"kind":"command","command":"…","workspace"?,"timeoutSec"?} — a command line run in the project folder (yours by default) below normal priority; or {"kind":"session","prompt":"…","check"?,"untilDone"?,"profileId"?,"taskId"?,"workspace"?,"options"?} — a session with that prompt (by default with your model, in your own task; taskId null: a new task each time, in project workspace). workspace: the name, id or folder path of a project (project_context) — for a session of a task, the folder it works in when that is not the task folder.',
        'check (session only): {"kind":"command","command":"…"} or {"kind":"builtin","name":"…"} (duty_list lists them) runs first; the session starts only when it finds something — a command finds something by printing it and exiting 0 (nothing printed = nothing to do; another exit code = the check failed) — and what it found is put under the prompt; the same finding does not start a second session.',
        `A command (action or check) that prints a line ${DUTY_DONE_MARK} turns the item off after this run. untilDone: true tells the session it may turn the item off with duty_stop once what it watches for is done.`,
        "Scripts you write for it: keep them in the project, make them print only what matters, and test them once yourself first.",
      ].join(" "),
      inputSchema: {
        id: z.string().optional(),
        title: z.string().optional(),
        schedule: z.object({ every: z.number().optional(), daily: z.string().optional() }).optional(),
        action: z.record(z.string(), z.unknown()).optional(),
        enabled: z.boolean().optional(),
      },
      readOnly: false,
      autoApprove: false,
      run: (args) =>
        write(caller, (c) => {
          // A session in the caller's own task with its model; commands in the caller's project.
          const session = service.store.getSession(c.sessionId);
          const task = session?.taskId ? service.store.getTask(session.taskId) : null;
          const withDefaults = (a: Record<string, unknown>): Record<string, unknown> => {
            const out = { ...a };
            if (a.kind === "session") {
              if (out.profileId === undefined && session) out.profileId = session.profileId;
              // A topic's session has no task: a new one each time.
              if (out.taskId === undefined) out.taskId = session?.taskId ?? null;
            }
            // By name or path, as session_start takes it (2026-10-31: the 维护 task's 值守 works in the 值守 directory).
            if (typeof a.workspace === "string" && a.workspace) out.workspaceId = service.sessions.workspaceByRef(a.workspace).id;
            delete out.workspace;
            if (a.kind === "command" && out.workspaceId === undefined && task) out.workspaceId = task.workspaceId;
            const check = a.check as Record<string, unknown> | undefined;
            // A check runs where the session would work.
            if (check?.kind === "command") {
              const { workspace, ...rest } = check;
              const workspaceId = typeof workspace === "string" && workspace ? service.sessions.workspaceByRef(workspace).id : (check.workspaceId ?? out.workspaceId ?? task?.workspaceId);
              out.check = { ...rest, ...(workspaceId ? { workspaceId } : {}) };
            }
            return out;
          };
          const input: DutyItemInput = {};
          if (args.title !== undefined) input.title = args.title as string;
          if (args.schedule !== undefined) input.schedule = args.schedule as DutyItemInput["schedule"];
          if (args.enabled !== undefined) input.enabled = args.enabled as boolean;
          if (args.action !== undefined) input.action = withDefaults(args.action as Record<string, unknown>) as DutyItemInput["action"];
          const saved = args.id === undefined ? duty.create({ ...input, enabled: input.enabled ?? true }, "agent", c.sessionId).items.at(-1)! : duty.update(String(args.id), input, "agent", c.sessionId).items.find((i) => i.id === args.id)!;
          return { item: shown(saved), note: saved.enabled ? "已保存并开着，到点就运行；人在 设置 → 值守 里能看到它（标着 AI 建的）。" : "已保存，关着。" };
        }),
    },
    {
      name: "duty_stop",
      title: "关掉值守项",
      description: "Turn a 值守 item off: id, or (in a session a 值守 item started) without id the item that started you. A run going on finishes. The person can turn it on again in 设置 → 值守.",
      inputSchema: { id: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const id = args.id !== undefined ? String(args.id) : duty.itemForSession(c.sessionId)?.id;
          if (!id) throw new HostError("bad_request", "这个会话不是值守开的：要给出值守项的 id（duty_list 能查）。");
          return { item: shown(duty.turnOff(id)), note: "值守项已关掉。" };
        }),
    },
  ];
}
