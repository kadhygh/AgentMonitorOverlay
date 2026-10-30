import { spawn, execFile } from "node:child_process";
import { DUTY_MIN_EVERY, type DutyAction, type DutyItem, type DutyItemInput, type DutyRun, type DutySchedule, type DutyState, type Id, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { withoutHostEnv } from "../../runtime/agent-env.js";
import { lowerAgentPriority } from "../../runtime/priority.js";
import { sessionMoving } from "../tasks/service.js";

// 值守 (duty, 2026-10-31, plans/issues.md): items that run at set times — every so many seconds, or once a day — and do
// one thing: start a session with a set prompt (in a task, or a new task each time), run a command line, or run one of
// Studio's own jobs (a feature registers it: 问题页's polling and packaging, stage 3–4). Waiting and counting are code;
// a model runs only when an item's action is a session. An item runs once at a time: while its last run goes on (its
// session still at work, its command not ended) the next one is skipped. Before a session it looks at the model's
// subscription: (nearly) used up, it takes the fallback model or skips. It never restarts the Host or updates Studio.

const ITEMS_KEY = "duty.items";
const RUNS_KEY = "duty.runs";
const RUNS_PER_ITEM = 5;
const TICK_MS = 1000;
/** A subscription window used this much counts as used up. */
const USED_UP_PERCENT = 95;
const DEFAULT_TIMEOUT_SEC = 30 * 60;
const OUTPUT_KEPT = 4000;
/** A session that has not started moving this long after it was made is taken as done (it answered at once, or failed). */
const SESSION_GRACE_MS = 15_000;

export interface DutyJobResult {
  ok: boolean;
  summary: string;
  skipped?: boolean;
  sessionId?: Id;
  taskId?: Id;
}

/** One of Studio's own jobs a builtin item names (registered by the feature that owns it). */
export interface DutyJob {
  name: string;
  label: string;
  description: string;
  run(ctx: { item: DutyItem; signal: AbortSignal }): Promise<DutyJobResult>;
  /** The item it ships, off until the person turns it on. */
  item?: { id: Id; title: string; schedule: DutySchedule };
}

interface Running {
  abort: AbortController;
  run: DutyRun;
  /** A session action: done once the session stops moving. */
  sessionId?: Id;
  seenMoving?: boolean;
}

export class DutyFeature extends Feature {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Map<Id, Running>();
  private readonly jobs = new Map<string, DutyJob>();
  /** Tests: the clock. */
  now: () => number = Date.now;

  // ---- what is kept

  items(): DutyItem[] {
    try {
      return JSON.parse(this.store.getKv(ITEMS_KEY)?.value ?? "[]") as DutyItem[];
    } catch {
      return [];
    }
  }

  private saveItems(items: DutyItem[]): void {
    this.store.setKv(ITEMS_KEY, JSON.stringify(items));
  }

  runs(): DutyRun[] {
    try {
      return JSON.parse(this.store.getKv(RUNS_KEY)?.value ?? "[]") as DutyRun[];
    } catch {
      return [];
    }
  }

  private saveRun(run: DutyRun): void {
    const others = this.runs().filter((r) => !(r.itemId === run.itemId && r.startedAt === run.startedAt));
    const all = [run, ...others].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const per = new Map<Id, number>();
    const kept = all.filter((r) => {
      const n = (per.get(r.itemId) ?? 0) + 1;
      per.set(r.itemId, n);
      return n <= RUNS_PER_ITEM;
    });
    this.store.setKv(RUNS_KEY, JSON.stringify(kept));
  }

  state(): DutyState {
    const next: Record<Id, string> = {};
    for (const item of this.items()) {
      if (!item.enabled) continue;
      const at = this.nextRun(item);
      if (at !== null) next[item.id] = new Date(at).toISOString();
    }
    return {
      items: this.items(),
      runs: this.runs(),
      running: [...this.running.keys()],
      next,
      builtins: [...this.jobs.values()].map((j) => ({ name: j.name, label: j.label, description: j.description })),
    };
  }

  private changed(): void {
    // Not kept in the event log: the settings page reads GET /api/duty when it opens.
    this.host.emit("event", { type: "duty.updated", duty: this.state(), seq: this.store.lastEventSeq() });
  }

  // ---- the person's changes

  /** A feature's own job; its item (off) is added the first time. */
  register(job: DutyJob): void {
    this.jobs.set(job.name, job);
    if (job.item && !this.items().some((i) => i.id === job.item!.id)) {
      const at = new Date(this.now()).toISOString();
      this.saveItems([...this.items(), { id: job.item.id, title: job.item.title, enabled: false, schedule: job.item.schedule, action: { kind: "builtin", name: job.name }, builtin: true, createdAt: at, updatedAt: at }]);
    }
  }

  create(input: DutyItemInput): DutyState {
    const at = new Date(this.now()).toISOString();
    const item: DutyItem = { id: newId("duty"), title: title(input.title), enabled: input.enabled === true, schedule: schedule(input.schedule), action: this.action(input.action), createdAt: at, updatedAt: at };
    this.saveItems([...this.items(), item]);
    this.changed();
    return this.state();
  }

  update(id: Id, input: DutyItemInput): DutyState {
    const items = this.items();
    const item = items.find((i) => i.id === id);
    if (!item) throw new HostError("not_found", `值守项 ${id} 不在了`);
    if (item.builtin && input.action !== undefined) throw new HostError("bad_request", "Studio 自带的值守项只能开关、改时间");
    const next: DutyItem = {
      ...item,
      ...(input.title !== undefined ? { title: title(input.title) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.schedule !== undefined ? { schedule: schedule(input.schedule) } : {}),
      ...(input.action !== undefined ? { action: this.action(input.action) } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.saveItems(items.map((i) => (i.id === id ? next : i)));
    this.changed();
    return this.state();
  }

  remove(id: Id): DutyState {
    const item = this.items().find((i) => i.id === id);
    if (!item) throw new HostError("not_found", `值守项 ${id} 不在了`);
    if (item.builtin) throw new HostError("bad_request", "Studio 自带的值守项不能删，可以关掉");
    this.running.get(id)?.abort.abort();
    this.saveItems(this.items().filter((i) => i.id !== id));
    this.store.setKv(RUNS_KEY, JSON.stringify(this.runs().filter((r) => r.itemId !== id)));
    this.changed();
    return this.state();
  }

  /** 立即运行: now, unless it runs already. */
  runNow(id: Id): DutyState {
    const item = this.items().find((i) => i.id === id);
    if (!item) throw new HostError("not_found", `值守项 ${id} 不在了`);
    if (this.running.has(id)) throw new HostError("conflict", "它正在运行，等这次结束");
    void this.launch(item);
    return this.state();
  }

  private action(value: unknown): DutyAction {
    const a = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const optId = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (a.kind === "session") {
      const profileId = optId(a.profileId);
      if (!profileId) throw new HostError("bad_request", "要选一个模型");
      this.requireProfile(profileId);
      const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
      if (!prompt) throw new HostError("bad_request", "要写开会话时说的话");
      const taskId = optId(a.taskId);
      if (taskId) this.requireTask(taskId);
      const workspaceId = optId(a.workspaceId);
      if (workspaceId) this.requireLiveWorkspace(workspaceId);
      const fallbackProfileId = optId(a.fallbackProfileId);
      if (fallbackProfileId) this.requireProfile(fallbackProfileId);
      return { kind: "session", profileId, prompt, taskId, workspaceId, taskTitle: typeof a.taskTitle === "string" ? a.taskTitle.trim().slice(0, 100) : "", fallbackProfileId };
    }
    if (a.kind === "command") {
      const command = typeof a.command === "string" ? a.command.trim() : "";
      if (!command) throw new HostError("bad_request", "要写命令");
      const workspaceId = optId(a.workspaceId);
      if (workspaceId) this.requireLiveWorkspace(workspaceId);
      const timeoutSec = typeof a.timeoutSec === "number" && a.timeoutSec > 0 ? Math.min(Math.floor(a.timeoutSec), 24 * 3600) : DEFAULT_TIMEOUT_SEC;
      return { kind: "command", command, workspaceId, timeoutSec };
    }
    if (a.kind === "builtin") {
      if (typeof a.name !== "string" || !this.jobs.has(a.name)) throw new HostError("bad_request", `没有这个 Studio 任务：${String(a.name)}`);
      return { kind: "builtin", name: a.name };
    }
    throw new HostError("bad_request", "动作要是 session、command 或 builtin");
  }

  // ---- the clock

  start(): void {
    if (this.timer) return;
    // Runs the last Host left going: it is not watching them any more.
    for (const r of this.runs()) if (r.ok === null) this.saveRun({ ...r, endedAt: new Date(this.now()).toISOString(), ok: false, summary: "Studio 重启了，没等到这次结束" });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.running.values()) r.abort.abort();
  }

  /** When the item runs next (ms), from its last start (or when it was last changed). */
  nextRun(item: DutyItem): number | null {
    const last = this.runs().find((r) => r.itemId === item.id);
    const base = Math.max(last ? Date.parse(last.startedAt) : 0, Date.parse(item.updatedAt));
    if ("every" in item.schedule) return base + item.schedule.every * 1000;
    const [h, m] = item.schedule.daily.split(":").map(Number);
    const d = new Date(base);
    d.setHours(h!, m!, 0, 0);
    if (d.getTime() <= base) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** One look: sessions that stopped end their runs; items that are due start. */
  tick(): void {
    const now = this.now();
    for (const [id, r] of this.running) {
      if (!r.sessionId) continue;
      const s = this.store.getSession(r.sessionId);
      const moving = !!s && sessionMoving(s);
      if (moving) r.seenMoving = true;
      // A quick turn can start and end between two looks: a finished reply in it (the session is new) counts as moved.
      else if (!s || r.seenMoving || s.status === "error" || s.status === "interrupted" || this.store.listItems(s.id).some((i) => i.type === "agent" && !i.streaming) || now - Date.parse(r.run.startedAt) > SESSION_GRACE_MS) this.finish(id, r, sessionEnd(s));
    }
    for (const item of this.items()) {
      if (!item.enabled || this.running.has(item.id)) continue;
      const at = this.nextRun(item);
      if (at !== null && now >= at) void this.launch(item);
    }
  }

  private finish(id: Id, r: Running, result: DutyJobResult): void {
    if (this.running.get(id) !== r) return;
    this.running.delete(id);
    this.saveRun({ ...r.run, endedAt: new Date(this.now()).toISOString(), ok: result.ok, summary: result.summary, ...(result.skipped ? { skipped: true } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : {}), ...(result.taskId ? { taskId: result.taskId } : {}) });
    this.changed();
  }

  /** Starts a run; a session's run goes on until the session stops (tick). */
  async launch(item: DutyItem): Promise<void> {
    if (this.running.has(item.id)) return;
    const run: DutyRun = { itemId: item.id, startedAt: new Date(this.now()).toISOString(), endedAt: null, ok: null, summary: "运行中…" };
    const r: Running = { abort: new AbortController(), run };
    this.running.set(item.id, r);
    this.saveRun(run);
    this.changed();
    let result: DutyJobResult;
    try {
      const a = item.action;
      if (a.kind === "session") {
        const started = await this.startSession(item, a);
        if (started.sessionId && !started.skipped) {
          r.sessionId = started.sessionId;
          r.run = { ...run, summary: started.summary, sessionId: started.sessionId, ...(started.taskId ? { taskId: started.taskId } : {}) };
          this.saveRun(r.run);
          this.changed();
          return;
        }
        result = started;
      } else if (a.kind === "command") result = await this.runCommand(a, r.abort.signal);
      else {
        const job = this.jobs.get(a.name);
        result = job ? await job.run({ item, signal: r.abort.signal }) : { ok: false, summary: `没有这个 Studio 任务：${a.name}` };
      }
    } catch (err) {
      result = { ok: false, summary: err instanceof Error ? err.message : String(err) };
    }
    this.finish(item.id, r, result);
  }

  // ---- actions

  /** Whether the profile's subscription is (nearly) used up, as far as Studio can read it. */
  private async usedUp(profileId: Id): Promise<string | null> {
    const usage = this.runtime.usage ? await this.runtime.usage(profileId, false).catch(() => null) : null;
    const full = usage?.windows.find((w) => w.usedPercent !== null && w.usedPercent >= USED_UP_PERCENT);
    return full ? `${usage!.label}「${full.label}」已用 ${full.usedPercent}%` : null;
  }

  private async startSession(item: DutyItem, a: Extract<DutyAction, { kind: "session" }>): Promise<DutyJobResult> {
    let profileId = a.profileId;
    const full = await this.usedUp(profileId);
    let note = "";
    if (full) {
      const fallback = a.fallbackProfileId && !(await this.usedUp(a.fallbackProfileId)) ? a.fallbackProfileId : null;
      if (!fallback) return { ok: true, skipped: true, summary: `额度快用完了（${full}），这次跳过` };
      profileId = fallback;
      note = `（${full}，改用 ${this.requireProfile(fallback).label}）`;
    }
    if (a.taskId) {
      const task = this.store.getTask(a.taskId);
      if (!task || task.archivedAt) return { ok: false, summary: "要开会话的任务已经归档或删掉了" };
      const session = await this.f.tasks.addSession(task.id, { profileId, text: a.prompt });
      return { ok: true, summary: `在「${task.title}」里开了会话${note}`, sessionId: session.id, taskId: task.id };
    }
    const stamp = new Date(this.now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const titleText = `${a.taskTitle || item.title} · ${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    const made = await this.f.tasks.createTask({ title: titleText, ...(a.workspaceId ? { workspaceId: a.workspaceId } : {}), firstSession: { profileId, text: a.prompt } });
    return { ok: true, summary: `新建任务「${titleText}」${note}`, ...(made.session ? { sessionId: made.session.id } : {}), taskId: made.task.id };
  }

  private runCommand(a: Extract<DutyAction, { kind: "command" }>, signal: AbortSignal): Promise<DutyJobResult> {
    const ws = a.workspaceId ? this.store.getWorkspace(a.workspaceId) : this.commonWorkspace();
    if (!ws) return Promise.resolve({ ok: false, summary: "命令所在的项目不在了" });
    return new Promise((done) => {
      let output = "";
      const child = spawn(a.command, { cwd: ws.path, shell: true, windowsHide: true, env: withoutHostEnv(process.env) });
      lowerAgentPriority(child.pid);
      const keep = (b: Buffer) => {
        output = (output + b.toString("utf8")).slice(-OUTPUT_KEPT);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      let why = "";
      const kill = (reason: string) => {
        why = reason;
        if (child.pid === undefined) return;
        if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
        else child.kill("SIGTERM");
      };
      const timer = setTimeout(() => kill(`超过 ${Math.round((a.timeoutSec ?? DEFAULT_TIMEOUT_SEC) / 60)} 分钟没结束，停掉了`), (a.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000);
      timer.unref?.();
      signal.addEventListener("abort", () => kill("Studio 退出或值守项被删，停掉了"), { once: true });
      child.on("error", (err) => {
        clearTimeout(timer);
        done({ ok: false, summary: `运行不了：${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const last = output.trim().split(/\r?\n/).at(-1)?.trim().slice(0, 200) ?? "";
        if (why) return done({ ok: false, summary: why });
        done({ ok: code === 0, summary: `${code === 0 ? "完成" : `退出码 ${code}`}${last ? `：${last}` : ""}` });
      });
    });
  }
}

function title(value: unknown): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) throw new HostError("bad_request", "值守项要有名字");
  return t.slice(0, 80);
}

function schedule(value: unknown): DutySchedule {
  const s = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (typeof s.daily === "string") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.daily.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HostError("bad_request", "每天的时间写成 HH:MM，比如 02:00");
    return { daily: `${m[1]!.padStart(2, "0")}:${m[2]}` };
  }
  if (typeof s.every === "number" && Number.isFinite(s.every)) {
    if (s.every < DUTY_MIN_EVERY) throw new HostError("bad_request", `间隔至少 ${DUTY_MIN_EVERY} 秒`);
    return { every: Math.floor(s.every) };
  }
  throw new HostError("bad_request", "要写多久运行一次（every 秒数，或 daily HH:MM）");
}

function sessionEnd(s: Session | undefined): DutyJobResult {
  if (!s) return { ok: false, summary: "会话不在了" };
  if (s.status === "error") return { ok: false, summary: "会话出错停下了", sessionId: s.id };
  if (s.status === "interrupted") return { ok: false, summary: "会话被打断了", sessionId: s.id };
  return { ok: true, summary: "会话这一轮结束了", sessionId: s.id };
}
