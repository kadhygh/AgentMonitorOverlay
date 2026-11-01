import { z } from "zod";
import { DUTY_DONE_MARK, type DutyItem, type DutyItemInput } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, write, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

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
        'action: {"kind":"command","command":"…","workspace"?,"timeoutSec"?} — a command line run in the project folder (yours by default) below normal priority; or {"kind":"session","prompt":"…","check"?,"untilDone"?,"model"?,"permission"?,"effort"?,"taskId"?,"workspace"?} — a session with that prompt (by default in your own task; taskId null: a new task each time, in project workspace). model, permission (read-only, write or full) and effort as session_start takes them; left out: your model and your own permission (nobody is there to approve what it asks). workspace: the name, id or folder path of a project (project_context) — for a session of a task, the folder it works in when that is not the task folder.',
        'check (session only): {"kind":"command","command":"…"} or {"kind":"builtin","name":"…"} (duty_list lists them) runs first; the session starts only when it finds something — a command finds something by printing it and exiting 0 (nothing printed = nothing to do; another exit code = the check failed) — and what it found is put under the prompt; the same finding does not start a second session. Several things to look at for one session (one at a time in one folder): {"kind":"all","checks":[ …up to 5 of the above ]} — what they found together; a command check runs in the session folder unless it names its own workspace.',
        `A command (action or check) that prints a line ${DUTY_DONE_MARK} turns the item off after this run. untilDone: true tells the session it may turn the item off with duty_stop once what it watches for is done.`,
        "parentId: another item's id to hang this one under (shown as its child; one level; turning the parent off turns its children off, and a child is turned on only with its parent on); \"\" to take it off.",
        "Scripts you write for it: keep them in the project, make them print only what matters, and test them once yourself first.",
      ].join(" "),
      inputSchema: {
        id: z.string().optional(),
        title: z.string().optional(),
        schedule: z.object({ every: z.number().optional(), daily: z.string().optional() }).optional(),
        action: z.record(z.string(), z.unknown()).optional(),
        enabled: z.boolean().optional(),
        parentId: z.string().optional(),
      },
      readOnly: false,
      autoApprove: false,
      run: (args) =>
        writeAsync(caller, async (c) => {
          // A session in the caller's own task with its model; commands in the caller's project.
          const session = service.store.getSession(c.sessionId);
          const task = session?.taskId ? service.store.getTask(session.taskId) : null;
          const withDefaults = async (a: Record<string, unknown>): Promise<Record<string, unknown>> => {
            const { model, permission, effort, ...out } = a;
            if (a.kind === "session") {
              // Model, permission and effort as session_start names them (2026-10-31: the 维护 templates say "your model,
              // your permission"); a profileId with options as Studio keeps them goes as it is.
              if (out.profileId === undefined && session) {
                const picked = await service.sessions.optionsFor(c.sessionId, { model, permission, effort });
                out.profileId = picked.profileId;
                out.options = { ...picked.options, ...((a.options as object | undefined) ?? {}) };
              }
              // A topic's session has no task: a new one each time.
              if (out.taskId === undefined) out.taskId = session?.taskId ?? null;
            }
            // By name or path, as session_start takes it (2026-10-31: the 维护 task's 值守 works in the 值守 directory).
            if (typeof a.workspace === "string" && a.workspace) out.workspaceId = service.sessions.workspaceByRef(a.workspace).id;
            delete out.workspace;
            if (a.kind === "command" && out.workspaceId === undefined && task) out.workspaceId = task.workspaceId;
            const check = a.check as Record<string, unknown> | undefined;
            // A check runs where the session would work.
            const placed = (one: Record<string, unknown>): Record<string, unknown> => {
              if (one.kind !== "command") return one;
              const { workspace, ...rest } = one;
              const workspaceId = typeof workspace === "string" && workspace ? service.sessions.workspaceByRef(workspace).id : (one.workspaceId ?? out.workspaceId ?? task?.workspaceId);
              return { ...rest, ...(workspaceId ? { workspaceId } : {}) };
            };
            if (check?.kind === "all" && Array.isArray(check.checks)) out.check = { ...check, checks: (check.checks as Record<string, unknown>[]).map(placed) };
            else if (check) out.check = placed(check);
            return out;
          };
          const input: DutyItemInput = {};
          if (args.title !== undefined) input.title = args.title as string;
          if (args.schedule !== undefined) input.schedule = args.schedule as DutyItemInput["schedule"];
          if (args.enabled !== undefined) input.enabled = args.enabled as boolean;
          if (args.parentId !== undefined) input.parentId = (args.parentId as string) || null;
          if (args.action !== undefined) input.action = (await withDefaults(args.action as Record<string, unknown>)) as DutyItemInput["action"];
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
