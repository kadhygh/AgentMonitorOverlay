import { useEffect, useState } from "react";
import { projectWorkspaces, type DutyAction, type DutyItem, type DutyItemInput, type DutyRun, type DutySchedule, type DutyState, type ModelProfile, type StateSnapshot } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { defaultModel, effortLabel, useProfileChoices } from "../lib/choices.js";

// 设置 → 值守 (2026-10-31, plans/issues.md): items that run at set times — start a session with a set prompt, run a
// command, or one of Studio's own jobs. The list says when each runs next and how its last run went; 立即运行 runs one
// now. Studio's own items (问题页's) can be turned on and timed, not removed.

const UNITS = [
  ["秒", 1],
  ["分钟", 60],
  ["小时", 3600],
] as const;

function scheduleText(s: DutySchedule): string {
  if ("daily" in s) return `每天 ${s.daily}`;
  const unit = [...UNITS].reverse().find(([, n]) => s.every % n === 0) ?? UNITS[0];
  return `每 ${s.every / unit[1]} ${unit[0]}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}-${d.getDate()} ${t}`;
}

function runMark(run: DutyRun | undefined, running: boolean): string {
  if (running) return "◐ 运行中";
  if (!run) return "○ 还没运行过";
  if (run.ok === null) return "◐ 运行中";
  if (run.skipped) return "○ 跳过";
  return run.ok ? "✓ 完成" : "! 失败";
}

interface Ctx {
  profiles: ModelProfile[];
  snapshot: StateSnapshot | null;
  builtins: DutyState["builtins"];
  checks: DutyState["checks"];
}

function actionText(a: DutyAction, ctx: Ctx): string {
  const profile = (id?: string | null) => ctx.profiles.find((p) => p.id === id)?.label ?? id ?? "";
  if (a.kind === "builtin") return `Studio：${ctx.builtins.find((b) => b.name === a.name)?.label ?? a.name}`;
  if (a.kind === "command") {
    const ws = ctx.snapshot?.workspaces.find((w) => w.id === a.workspaceId);
    return `命令：${a.command}${ws ? `（在「${ws.name}」里）` : ""}`;
  }
  const task = ctx.snapshot?.tasks.find((t) => t.id === a.taskId);
  const ws = ctx.snapshot?.workspaces.find((w) => w.id === a.workspaceId);
  const where = task ? `在任务「${task.title}」里` : `每次新建任务${ws ? `（项目「${ws.name}」）` : ""}`;
  const c = a.check;
  const check = !c ? "" : c.kind === "builtin" ? `先检查「${ctx.checks.find((x) => x.name === c.name)?.label ?? c.name}」，有事才开` : `先跑检查命令 ${c.command}，有输出才开`;
  return `${check ? `${check}；` : ""}开会话：${profile(a.profileId)}${a.fallbackProfileId ? `，额度不够时用 ${profile(a.fallbackProfileId)}` : ""}，${where}`;
}

export function DutyPage({ link }: { link: HostLink }) {
  const [state, setState] = useState<DutyState | null>(null);
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [editing, setEditing] = useState<DutyItem | "new" | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  useEffect(() => {
    call(link, "GET /api/duty").then(setState, fail);
    call(link, "GET /api/state").then(setSnapshot, fail);
    return onHostEvent((e) => {
      if (e.type === "duty.updated") setState(e.duty);
    });
  }, [link]);

  const profiles = (snapshot?.profiles ?? []).filter((p) => !p.hidden && p.runtime !== "remote");
  const ctx: Ctx = { profiles, snapshot, builtins: state?.builtins ?? [], checks: state?.checks ?? [] };
  const act = (run: () => Promise<DutyState>) => {
    setMessage(null);
    run().then(setState, fail);
  };

  return (
    <section className="settings-section" aria-label="值守">
      <span className="settings-heading">值守</span>
      <span className="settings-hint">到点了就做一件事：开一个会话、跑一条命令，或者 Studio 自带的任务。等待和计时不用模型，只有动作是开会话时才用额度；同一项上一次还没结束，这次就跳过。Studio 退出时值守也停。</span>
      {!state ? (
        <span className="settings-hint">读取中…</span>
      ) : (
        <ul className="duty-list" data-testid="duty-list">
          {state.items.length === 0 && <li className="settings-hint">还没有值守项。</li>}
          {state.items.map((item) => {
            const run = state.runs.find((r) => r.itemId === item.id);
            const running = state.running.includes(item.id);
            return (
              <li key={item.id} className="duty-item" data-testid="duty-item" data-enabled={item.enabled}>
                <div className="duty-item-head">
                  <label className="duty-toggle">
                    <input type="checkbox" checked={item.enabled} onChange={(e) => act(() => call(link, "PATCH /api/duty/items/:id", { id: item.id }, { enabled: e.target.checked }))} aria-label={`开启「${item.title}」`} />
                    <b>{item.title}</b>
                  </label>
                  {item.builtin && <span className="settings-tag">Studio 自带</span>}
                  <span className="settings-hint">{scheduleText(item.schedule)}</span>
                  <span className="grow" />
                  <button type="button" className="btn-ghost small" disabled={running} onClick={() => act(() => call(link, "POST /api/duty/items/:id/run", { id: item.id }))}>
                    立即运行
                  </button>
                  <button type="button" className="btn-ghost small" onClick={() => setEditing(item)}>
                    编辑
                  </button>
                  {!item.builtin && (
                    <button type="button" className="btn-ghost small soft-danger" onClick={() => window.confirm(`删掉值守项「${item.title}」？`) && act(() => call(link, "DELETE /api/duty/items/:id", { id: item.id }))}>
                      删除
                    </button>
                  )}
                </div>
                <div className="settings-hint">{actionText(item.action, ctx)}</div>
                <div className="duty-run" data-testid="duty-run">
                  <span className={`duty-mark ${running || run?.ok === null ? "on" : run?.ok === false && !run.skipped ? "bad" : ""}`}>{runMark(run, running)}</span>
                  {run && <span>{when(run.startedAt)}{run.summary && run.ok !== null ? ` · ${run.summary}` : ""}</span>}
                  {item.enabled && state.next[item.id] && !running && <span className="settings-hint">下次 {when(state.next[item.id])}</span>}
                </div>
                {editing !== "new" && editing?.id === item.id && <DutyForm link={link} ctx={ctx} item={item} onDone={(s) => { if (s) setState(s); setEditing(null); }} />}
              </li>
            );
          })}
        </ul>
      )}
      {editing === "new" ? (
        <DutyForm link={link} ctx={ctx} item={null} onDone={(s) => { if (s) setState(s); setEditing(null); }} />
      ) : (
        <div className="settings-row">
          <button type="button" className="btn-primary small" onClick={() => setEditing("new")} data-testid="duty-new">
            新建值守项
          </button>
        </div>
      )}
      {message && <span className={`settings-hint${message.error ? " error" : ""}`}>{message.text}</span>}
    </section>
  );
}

function DutyForm({ link, ctx, item, onDone }: { link: HostLink; ctx: Ctx; item: DutyItem | null; onDone(state: DutyState | null): void }) {
  const a = item?.action;
  const builtin = !!item?.builtin;
  const [title, setTitle] = useState(item?.title ?? "");
  const [daily, setDaily] = useState(item && "daily" in item.schedule ? item.schedule.daily : "");
  const every = item && "every" in item.schedule ? item.schedule.every : 1800;
  const startUnit = [...UNITS].reverse().find(([, n]) => every % n === 0) ?? UNITS[0];
  const [amount, setAmount] = useState(String(every / startUnit[1]));
  const [unit, setUnit] = useState<number>(startUnit[1]);
  const [mode, setMode] = useState<"every" | "daily">(item && "daily" in item.schedule ? "daily" : "every");
  const [kind, setKind] = useState<DutyAction["kind"]>(a?.kind ?? "session");
  const [profileId, setProfileId] = useState(a?.kind === "session" ? a.profileId : (ctx.profiles[0]?.id ?? ""));
  const [model, setModel] = useState(a?.kind === "session" ? (a.options?.model ?? "") : "");
  const [effort, setEffort] = useState(a?.kind === "session" ? (a.options?.effort ?? "") : "");
  const [permission, setPermission] = useState(a?.kind === "session" ? (a.options?.permission ?? "") : "");
  const { choices } = useProfileChoices(link, kind === "session" && profileId ? profileId : null);
  const shownModel = choices && ((model && choices.models.find((m) => m.id === model)) || defaultModel(choices));
  const [fallback, setFallback] = useState(a?.kind === "session" ? (a.fallbackProfileId ?? "") : "");
  const [prompt, setPrompt] = useState(a?.kind === "session" ? a.prompt : "");
  const [taskId, setTaskId] = useState(a?.kind === "session" ? (a.taskId ?? "") : "");
  const [workspaceId, setWorkspaceId] = useState(a?.kind === "session" || a?.kind === "command" ? (a.workspaceId ?? "") : "");
  const [taskTitle, setTaskTitle] = useState(a?.kind === "session" ? (a.taskTitle ?? "") : "");
  const [command, setCommand] = useState(a?.kind === "command" ? a.command : "");
  const [timeoutMin, setTimeoutMin] = useState(String(a?.kind === "command" ? Math.round((a.timeoutSec ?? 1800) / 60) : 30));
  const [name, setName] = useState(a?.kind === "builtin" ? a.name : (ctx.builtins[0]?.name ?? ""));
  const check = a?.kind === "session" ? a.check : null;
  const [checkKind, setCheckKind] = useState<"" | "command" | "builtin">(check?.kind ?? "");
  const [checkCommand, setCheckCommand] = useState(check?.kind === "command" ? check.command : "");
  const [checkWorkspace, setCheckWorkspace] = useState(check?.kind === "command" ? (check.workspaceId ?? "") : "");
  const [checkName, setCheckName] = useState(check?.kind === "builtin" ? check.name : (ctx.checks[0]?.name ?? ""));
  const [error, setError] = useState<string | null>(null);
  const tasks = (ctx.snapshot?.tasks ?? []).filter((t) => !t.archivedAt && !t.remote);
  const projects = projectWorkspaces(ctx.snapshot?.workspaces ?? []);

  function input(): DutyItemInput {
    const schedule: DutySchedule = mode === "daily" ? { daily } : { every: Math.round(Number(amount) * unit) };
    if (builtin) return { title, schedule };
    const action: DutyAction =
      kind === "session"
        ? { kind, profileId, prompt, taskId: taskId || null, workspaceId: workspaceId || null, taskTitle, options: { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permission ? { permission } : {}) }, fallbackProfileId: fallback || null, check: checkKind === "command" ? { kind: "command", command: checkCommand, workspaceId: checkWorkspace || null } : checkKind === "builtin" ? { kind: "builtin", name: checkName } : null }
        : kind === "command"
          ? { kind, command, workspaceId: workspaceId || null, timeoutSec: Math.round(Number(timeoutMin) * 60) }
          : { kind, name };
    return { title, schedule, action };
  }

  function save() {
    setError(null);
    const body = input();
    const done = item ? call(link, "PATCH /api/duty/items/:id", { id: item.id }, body) : call(link, "POST /api/duty/items", {}, { ...body, enabled: true });
    done.then(onDone, (err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  }

  return (
    <div className="duty-form" data-testid="duty-form">
      <label className="stack-field">
        名字
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如 问题页：修新问题" aria-label="值守项名字" />
      </label>
      <div className="settings-row">
        <span className="settings-label">多久一次</span>
        <div role="radiogroup" aria-label="多久一次" className="chips">
          <button type="button" role="radio" className="chip" aria-checked={mode === "every"} aria-pressed={mode === "every"} onClick={() => setMode("every")}>
            每隔
          </button>
          <button type="button" role="radio" className="chip" aria-checked={mode === "daily"} aria-pressed={mode === "daily"} onClick={() => setMode("daily")}>
            每天定时
          </button>
        </div>
        {mode === "every" ? (
          <>
            <input className="field duty-num" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="间隔" />
            <select className="field" value={unit} onChange={(e) => setUnit(Number(e.target.value))} aria-label="间隔单位">
              {UNITS.map(([label, n]) => (
                <option key={n} value={n}>
                  {label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <input className="field duty-num" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="02:00" aria-label="每天几点" />
        )}
      </div>
      {!builtin && (
        <>
          <div className="settings-row">
            <span className="settings-label">做什么</span>
            <div role="radiogroup" aria-label="做什么" className="chips">
              <button type="button" role="radio" className="chip" aria-checked={kind === "session"} aria-pressed={kind === "session"} onClick={() => setKind("session")}>
                开会话
              </button>
              <button type="button" role="radio" className="chip" aria-checked={kind === "command"} aria-pressed={kind === "command"} onClick={() => setKind("command")}>
                跑命令
              </button>
              {ctx.builtins.length > 0 && (
                <button type="button" role="radio" className="chip" aria-checked={kind === "builtin"} aria-pressed={kind === "builtin"} onClick={() => setKind("builtin")}>
                  Studio 自带
                </button>
              )}
            </div>
          </div>
          {kind === "session" && (
            <>
              <div className="settings-row">
                <span className="settings-label">模型</span>
                <select
                  className="field"
                  value={profileId}
                  onChange={(e) => {
                    // Model, effort and permissions are the profile's own: a new profile starts from its defaults.
                    setProfileId(e.target.value);
                    setModel("");
                    setEffort("");
                    setPermission("");
                  }}
                  aria-label="值守的模型"
                >
                  {ctx.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="settings-label">额度不够时改用</span>
                <select className="field" value={fallback} onChange={(e) => setFallback(e.target.value)} aria-label="额度不够时改用">
                  <option value="">不改用，跳过这次</option>
                  {ctx.profiles
                    .filter((p) => p.id !== profileId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </div>
              {choices && (
                <div className="settings-row">
                  <span className="settings-label">型号</span>
                  <select className="field" value={model} onChange={(e) => { setModel(e.target.value); setEffort(""); }} aria-label="值守会话的型号">
                    <option value="">默认{defaultModel(choices) ? `（${defaultModel(choices)!.label}）` : ""}</option>
                    {choices.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {!!shownModel?.efforts.length && (
                    <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="值守会话的思考强度">
                      <option value="">默认{shownModel.defaultEffort ? `（${effortLabel(shownModel.defaultEffort)}）` : ""}</option>
                      {shownModel.efforts.map((x) => (
                        <option key={x} value={x}>
                          {effortLabel(x)}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="settings-label">权限</span>
                  <select className="field" value={permission} onChange={(e) => setPermission(e.target.value)} aria-label="值守会话的权限">
                    <option value="">默认（{choices.permissions.find((p) => p.id === choices.defaultPermission)?.label ?? choices.defaultPermission}）</option>
                    {choices.permissions.map((p) => (
                      <option key={p.id} value={p.id} disabled={!!p.unavailable}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <span className="settings-hint">没人看着时，选一个不用逐条询问的权限，不然会话会停在等你批准。额度不够改用别的模型时，用那个模型的默认设置。</span>
              <div className="settings-row">
                <span className="settings-label">在哪</span>
                <select className="field" value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="在哪个任务里开会话">
                  <option value="">每次新建一个任务</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      任务「{t.title}」
                    </option>
                  ))}
                </select>
                {!taskId && (
                  <>
                    <select className="field" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="新任务的项目">
                      <option value="">不属于项目</option>
                      {projects.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <input className="field duty-grow" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="新任务的名字（不填用值守项的名字）" aria-label="新任务的名字" />
                  </>
                )}
              </div>
              <label className="stack-field">
                开会话时说的话
                <textarea className="field" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="开会话时说的话" />
              </label>
              <div className="settings-row">
                <span className="settings-label">先检查</span>
                <div role="radiogroup" aria-label="先检查" className="chips">
                  <button type="button" role="radio" className="chip" aria-checked={checkKind === ""} aria-pressed={checkKind === ""} onClick={() => setCheckKind("")}>
                    不检查，到点就开
                  </button>
                  <button type="button" role="radio" className="chip" aria-checked={checkKind === "command"} aria-pressed={checkKind === "command"} onClick={() => setCheckKind("command")}>
                    跑检查命令
                  </button>
                  {ctx.checks.length > 0 && (
                    <button type="button" role="radio" className="chip" aria-checked={checkKind === "builtin"} aria-pressed={checkKind === "builtin"} onClick={() => setCheckKind("builtin")}>
                      Studio 自带检查
                    </button>
                  )}
                </div>
              </div>
              {checkKind === "command" && (
                <div className="settings-row">
                  <input className="field mono duty-grow" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} placeholder="例如 node scripts/check.mjs" aria-label="检查命令" />
                  <select className="field" value={checkWorkspace} onChange={(e) => setCheckWorkspace(e.target.value)} aria-label="检查命令所在的项目">
                    <option value="">公共目录</option>
                    {projects.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {checkKind === "builtin" && (
                <div className="settings-row">
                  <select className="field" value={checkName} onChange={(e) => setCheckName(e.target.value)} aria-label="Studio 自带检查">
                    {ctx.checks.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <span className="settings-hint">{ctx.checks.find((c) => c.name === checkName)?.description}</span>
                </div>
              )}
              {checkKind && <span className="settings-hint">到点先检查，有事才开会话，检查发现的内容接在上面那段话后面。{checkKind === "command" ? "检查命令有输出、退出码 0 算有事；没输出算没事；别的退出码算检查失败。" : ""}和上次开会话时一模一样的发现不会再开一次。</span>}
            </>
          )}
          {kind === "command" && (
            <>
              <label className="stack-field">
                命令
                <input className="field mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如 npm run relay:mac -- status" aria-label="命令" />
              </label>
              <div className="settings-row">
                <span className="settings-label">在哪个项目里跑</span>
                <select className="field" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="命令所在的项目">
                  <option value="">公共目录</option>
                  {projects.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <span className="settings-label">超时</span>
                <input className="field duty-num" type="number" min={1} value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} aria-label="超时分钟" />
                <span className="settings-hint">分钟</span>
              </div>
            </>
          )}
          {kind === "builtin" && (
            <div className="settings-row">
              <span className="settings-label">Studio 自带</span>
              <select className="field" value={name} onChange={(e) => setName(e.target.value)} aria-label="Studio 自带的任务">
                {ctx.builtins.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.label}
                  </option>
                ))}
              </select>
              <span className="settings-hint">{ctx.builtins.find((b) => b.name === name)?.description}</span>
            </div>
          )}
        </>
      )}
      {error && <span className="settings-hint error">{error}</span>}
      <div className="settings-row">
        <button type="button" className="btn-primary small" onClick={save} data-testid="duty-save">
          保存
        </button>
        <button type="button" className="btn-ghost small" onClick={() => onDone(null)}>
          取消
        </button>
      </div>
    </div>
  );
}
