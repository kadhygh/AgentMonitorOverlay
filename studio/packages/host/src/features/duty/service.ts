import { spawn, execFile } from "node:child_process";
import { DUTY_CHECKS_MAX, DUTY_DONE_MARK, DUTY_MIN_EVERY, type DutyAction, type DutyCheck, type DutyCheckOne, type DutyItem, type DutyItemInput, type DutyRun, type DutySchedule, type DutyState, type Id, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { withoutHostEnv } from "../../runtime/agent-env.js";
import { lowerAgentPriority } from "../../runtime/priority.js";
import { sessionMoving } from "../tasks/service.js";

// 值守 (duty, 2026-10-31, plans/issues.md): items that run at set times — every so many seconds, or once a day — and do
// one thing: start a session with a set prompt (in a task, or a new task each time), run a command line, or run one of
// Studio's own jobs (a feature registers it). Waiting and counting are code;
// a model runs only when an item's action is a session. An item runs once at a time: while its last run goes on (its
// session still at work, its command not ended) the next one is skipped. Before a session it looks at the model's
// subscription: (nearly) used up, it takes the fallback model or skips. It never restarts the Host or updates Studio.
// A session item can check first (a command, or a feature's check such as 问题页's): the model starts only when the
// check finds something, with what it found under the prompt; a finding that already started a session is not acted on
// again (the user, 2026-10-31: "每次都先走脚本，有问题才拉起ai").
// An item can hang under another (parentId, 2026-11-01: 自动打包 under 日常值守): only the relation is shown, they run
// apart; the parent turned off turns its children off, and a child is turned on only with its parent on.

const ITEMS_KEY = "duty.items";
const RUNS_KEY = "duty.runs";
/** Per item: what its check found the last time that started a session. */
const FOUND_KEY = "duty.found";
/** The sessions 值守 started → their item (2026-10-31: marked in Studio; duty_stop finds its item by it). */
const SESSIONS_KEY = "duty.sessions";
const SESSIONS_KEPT = 300;
/** A check gets this long by default. */
const CHECK_TIMEOUT_SEC = 120;
const FOUND_KEPT = 8000;
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
  /** Went on in an older session: the replies it had before. */
  repliesBefore?: number;
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

/**
 * What a check found; the session that already worked on it — 值守 goes on in that one when it is this item's, idle
 * and still there (问题 #1's follow-up, the user, 2026-10-31: "没有在旧的继续，而是拉了个新的session"); and the name
 * for a new session (the user, 2026-10-31: "issueid + 一句话说明").
 */
export interface DutyFinding {
  text: string;
  sessionId?: Id;
  title?: string;
}

/** One of Studio's own checks a session item can run first: what there is to do, or null for nothing. */
export interface DutyCheckJob {
  name: string;
  label: string;
  description: string;
  run(ctx: { item: DutyItem; signal: AbortSignal }): Promise<string | DutyFinding | null>;
}

interface Running {
  abort: AbortController;
  run: DutyRun;
  /** A session action: done once the session stops moving. */
  sessionId?: Id;
  seenMoving?: boolean;
  /** An older session it went on in: its replies before this run (a newer one is this run's). */
  repliesBefore?: number;
}

export class DutyFeature extends Feature {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Map<Id, Running>();
  private readonly jobs = new Map<string, DutyJob>();
  private readonly checks = new Map<string, DutyCheckJob>();
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
      sessions: this.sessions(),
      next,
      builtins: [...this.jobs.values()].map((j) => ({ name: j.name, label: j.label, description: j.description })),
      checks: [...this.checks.values()].map((j) => ({ name: j.name, label: j.label, description: j.description })),
    };
  }

  private changed(): void {
    // Not kept in the event log: the settings page reads GET /api/duty when it opens.
    this.host.emit("event", { type: "duty.updated", duty: this.state(), seq: this.store.lastEventSeq() });
  }

  // ---- the person's changes

  /** A feature's own check, for session items to run first. */
  registerCheck(check: DutyCheckJob): void {
    this.checks.set(check.name, check);
  }

  private found(): Record<Id, string> {
    try {
      return JSON.parse(this.store.getKv(FOUND_KEY)?.value ?? "{}") as Record<Id, string>;
    } catch {
      return {};
    }
  }

  private setFound(itemId: Id, text: string | null): void {
    const all = this.found();
    if (text === null) delete all[itemId];
    else all[itemId] = text;
    this.store.setKv(FOUND_KEY, JSON.stringify(all));
  }

  private sessions(): Record<Id, Id> {
    try {
      return JSON.parse(this.store.getKv(SESSIONS_KEY)?.value ?? "{}") as Record<Id, Id>;
    } catch {
      return {};
    }
  }

  private keepSession(sessionId: Id, itemId: Id): void {
    // Insertion order: the oldest go first.
    const all = Object.entries({ ...this.sessions(), [sessionId]: itemId }).slice(-SESSIONS_KEPT);
    this.store.setKv(SESSIONS_KEY, JSON.stringify(Object.fromEntries(all)));
  }

  /** A feature's own job; its item (off) is added the first time. */
  register(job: DutyJob): void {
    this.jobs.set(job.name, job);
    if (job.item && !this.items().some((i) => i.id === job.item!.id)) {
      const at = new Date(this.now()).toISOString();
      this.saveItems([...this.items(), { id: job.item.id, title: job.item.title, enabled: false, schedule: job.item.schedule, action: { kind: "builtin", name: job.name }, builtin: true, createdAt: at, updatedAt: at }]);
    }
  }

  /** `by` "agent": saved by an agent (duty_save, which the person approved); the list marks it. */
  create(input: DutyItemInput, by?: "agent", setBy?: Id): DutyState {
    const at = new Date(this.now()).toISOString();
    const id = newId("duty");
    const parentId = input.parentId ? this.parentFor(id, input.parentId) : undefined;
    const item: DutyItem = { id, title: title(input.title), enabled: input.enabled === true, schedule: schedule(input.schedule), action: this.action(input.action), ...(by ? { by } : {}), ...(by && setBy ? { setBy } : {}), ...(parentId ? { parentId } : {}), createdAt: at, updatedAt: at };
    if (item.enabled) this.parentOn(item);
    this.saveItems([...this.items(), item]);
    this.changed();
    return this.state();
  }

  update(id: Id, input: DutyItemInput, by?: "agent", setBy?: Id): DutyState {
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
    if (input.parentId !== undefined) {
      if (input.parentId) next.parentId = this.parentFor(id, input.parentId);
      else delete next.parentId;
    }
    if (next.enabled && (!item.enabled || input.parentId !== undefined)) this.parentOn(next);
    // Who saved it last: an agent's change marks it; the person's own edit (not just turning it on or off) clears that.
    if (by) {
      next.by = by;
      if (setBy) next.setBy = setBy;
    } else if (input.title !== undefined || input.schedule !== undefined || input.action !== undefined) {
      delete next.by;
      delete next.setBy;
    }
    // The parent off: its children with it (a run going on finishes).
    const offToo = item.enabled && !next.enabled ? new Set(items.filter((i) => i.parentId === id && i.enabled).map((i) => i.id)) : new Set<Id>();
    const at = next.updatedAt;
    this.saveItems(items.map((i) => (i.id === id ? next : offToo.has(i.id) ? { ...i, enabled: false, updatedAt: at } : i)));
    this.changed();
    return this.state();
  }

  /** The parent `parentId` may be for item `id`: there, not itself, not a child itself, and `id` has no children. */
  private parentFor(id: Id, parentId: Id): Id {
    const items = this.items();
    const parent = items.find((i) => i.id === parentId);
    if (!parent) throw new HostError("not_found", `父值守项 ${parentId} 不在了`);
    if (parentId === id) throw new HostError("bad_request", "值守项不能挂在自己下面");
    if (parent.parentId) throw new HostError("bad_request", `「${parent.title}」自己挂在别的值守项下面，只能挂一层`);
    if (items.some((i) => i.parentId === id)) throw new HostError("bad_request", "这个值守项下面已经挂着别的，不能再挂到别人下面");
    return parentId;
  }

  /** A child turned on needs its parent on. */
  private parentOn(item: DutyItem): void {
    const parent = item.parentId ? this.items().find((i) => i.id === item.parentId) : undefined;
    if (parent && !parent.enabled) throw new HostError("conflict", `它挂在「${parent.title}」下面，「${parent.title}」关着：先开它`);
  }

  /** Turns an item off (a run going on finishes); duty_stop and a command's AMO_DUTY_DONE. */
  turnOff(id: Id): DutyItem {
    const item = this.items().find((i) => i.id === id);
    if (!item) throw new HostError("not_found", `值守项 ${id} 不在了`);
    if (item.enabled) this.update(id, { enabled: false });
    return this.items().find((i) => i.id === id)!;
  }

  /** The item whose run started this session (running now, or one of its kept runs). */
  itemForSession(sessionId: Id): DutyItem | null {
    const id = this.sessions()[sessionId] ?? [...this.running].find(([, r]) => r.sessionId === sessionId)?.[0] ?? this.runs().find((r) => r.sessionId === sessionId)?.itemId;
    return (id && this.items().find((i) => i.id === id)) || null;
  }

  remove(id: Id): DutyState {
    const item = this.items().find((i) => i.id === id);
    if (!item) throw new HostError("not_found", `值守项 ${id} 不在了`);
    if (item.builtin) throw new HostError("bad_request", "Studio 自带的值守项不能删，可以关掉");
    this.running.get(id)?.abort.abort();
    // Its children stay, on their own.
    this.saveItems(this.items().filter((i) => i.id !== id).map((i) => (i.parentId === id ? (({ parentId: _, ...rest }) => rest)(i) : i)));
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
      const check = a.check ? this.check(a.check) : null;
      const o = (a.options && typeof a.options === "object" ? a.options : {}) as Record<string, unknown>;
      const options = Object.fromEntries((["model", "effort", "permission"] as const).flatMap((k) => (typeof o[k] === "string" && o[k] ? [[k, o[k] as string]] : [])));
      return { kind: "session", profileId, prompt, taskId, workspaceId, taskTitle: typeof a.taskTitle === "string" ? a.taskTitle.trim().slice(0, 100) : "", ...(Object.keys(options).length ? { options } : {}), fallbackProfileId, ...(check ? { check } : {}), ...(a.untilDone === true ? { untilDone: true } : {}) };
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

  private check(value: unknown): DutyCheck {
    const c = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (c.kind === "all") {
      const list = Array.isArray(c.checks) ? c.checks : [];
      if (!list.length || list.length > DUTY_CHECKS_MAX) throw new HostError("bad_request", `几样检查要写 1 到 ${DUTY_CHECKS_MAX} 样`);
      return { kind: "all", checks: list.map((x) => this.checkOne(x)) };
    }
    return this.checkOne(c);
  }

  private checkOne(value: unknown): DutyCheckOne {
    const c = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (c.kind === "command") {
      const command = typeof c.command === "string" ? c.command.trim() : "";
      if (!command) throw new HostError("bad_request", "检查要写命令");
      const workspaceId = typeof c.workspaceId === "string" && c.workspaceId ? c.workspaceId : null;
      if (workspaceId) this.requireLiveWorkspace(workspaceId);
      const timeoutSec = typeof c.timeoutSec === "number" && c.timeoutSec > 0 ? Math.min(Math.floor(c.timeoutSec), 3600) : CHECK_TIMEOUT_SEC;
      return { kind: "command", command, workspaceId, timeoutSec };
    }
    if (c.kind === "builtin") {
      if (typeof c.name !== "string" || !this.checks.has(c.name)) throw new HostError("bad_request", `没有这个 Studio 检查：${String(c.name)}`);
      return { kind: "builtin", name: c.name };
    }
    throw new HostError("bad_request", "检查要是 command 或 builtin");
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
      // A quick turn can start and end between two looks: a finished reply in it counts as moved — one newer than this
      // run's start in an older session it went on in.
      else if (!s || r.seenMoving || s.status === "error" || s.status === "interrupted" || this.replies(s.id) > (r.repliesBefore ?? 0) || now - Date.parse(r.run.startedAt) > SESSION_GRACE_MS) this.finish(id, r, sessionEnd(s));
    }
    for (const item of this.items()) {
      if (!item.enabled || this.running.has(item.id)) continue;
      const at = this.nextRun(item);
      if (at !== null && now >= at) void this.launch(item);
    }
  }

  /** A session's finished replies. */
  private replies(sessionId: Id): number {
    return this.store.listItems(sessionId).filter((i) => i.type === "agent" && !i.streaming).length;
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
        const started = await this.startSession(item, a, r.abort.signal);
        if (started.sessionId && !started.skipped) {
          r.sessionId = started.sessionId;
          if (started.repliesBefore !== undefined) r.repliesBefore = started.repliesBefore;
          this.keepSession(started.sessionId, item.id);
          r.run = { ...run, summary: started.summary, sessionId: started.sessionId, ...(started.taskId ? { taskId: started.taskId } : {}) };
          this.saveRun(r.run);
          this.changed();
          return;
        }
        result = started;
      } else if (a.kind === "command") result = await this.runCommand(item, a, r.abort.signal);
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
    const answer = this.runtime.usage ? await this.runtime.usage(profileId, false).catch(() => null) : null;
    // Claude with several accounts: the one sessions run on now (listed first).
    const usage = Array.isArray(answer) ? (answer.find((u) => u.account?.current) ?? answer[0] ?? null) : answer;
    const full = usage?.windows.find((w) => w.usedPercent !== null && w.usedPercent >= USED_UP_PERCENT);
    return full ? `${usage!.label}「${full.label}」已用 ${full.usedPercent}%` : null;
  }

  /** What the item's check found: text to act on, null for nothing, or why the check failed; `done`: it printed AMO_DUTY_DONE. */
  private async runCheck(item: DutyItem, c: DutyCheck, signal: AbortSignal): Promise<{ found: string | null; done?: boolean; sessionId?: Id; title?: string } | { failed: string }> {
    if (c.kind === "all") {
      const found: Array<{ text: string; sessionId?: Id; title?: string }> = [];
      const failed: string[] = [];
      let done = true;
      for (const one of c.checks) {
        const r = await this.runCheck(item, one, signal);
        const name = one.kind === "builtin" ? (this.checks.get(one.name)?.label ?? one.name) : one.command;
        if ("failed" in r) failed.push(`「${name}」${r.failed}`);
        else if (r.found) found.push({ text: r.found, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.title ? { title: r.title } : {}) });
        if ("failed" in r || !r.done) done = false;
      }
      if (failed.length === c.checks.length) return { failed: failed.join("；") };
      const text = [...found.map((f) => f.text), ...(found.length && failed.length ? [`（没跑通的检查：${failed.join("；")}）`] : [])].join("\n\n");
      // An older session to go on in only when it is all that was found: something else is new work.
      const sessionId = found.length === 1 ? found[0]!.sessionId : undefined;
      const title = found.find((f) => f.title)?.title;
      return { found: text ? text.slice(0, FOUND_KEPT) : null, done, ...(sessionId ? { sessionId } : {}), ...(title ? { title } : {}) };
    }
    if (c.kind === "builtin") {
      const job = this.checks.get(c.name);
      if (!job) return { failed: `没有这个 Studio 检查：${c.name}` };
      try {
        const out = await job.run({ item, signal });
        const finding = typeof out === "string" ? { text: out } : out;
        const found = finding?.text.trim();
        if (!found) return { found: null };
        return { found: found.slice(0, FOUND_KEPT), ...(finding!.sessionId ? { sessionId: finding!.sessionId } : {}), ...(finding!.title?.trim() ? { title: finding!.title.trim().slice(0, 100) } : {}) };
      } catch (err) {
        return { failed: err instanceof Error ? err.message : String(err) };
      }
    }
    const out = await this.exec(c.command, c.workspaceId, c.timeoutSec ?? CHECK_TIMEOUT_SEC, signal);
    if (out.error) return { failed: out.error };
    if (out.code !== 0) return { failed: `退出码 ${out.code}${out.last ? `：${out.last}` : ""}` };
    const { done, rest } = doneMark(out.output);
    return { found: rest ? rest.slice(-FOUND_KEPT) : null, done };
  }

  private async startSession(item: DutyItem, a: Extract<DutyAction, { kind: "session" }>, signal: AbortSignal): Promise<DutyJobResult> {
    let prompt = a.prompt;
    let found: string | null = null;
    let lastWord = "";
    let goOnIn: Id | undefined;
    let sessionTitle: string | undefined;
    if (a.check) {
      const checked = await this.runCheck(item, a.check, signal);
      if ("failed" in checked) return { ok: false, summary: `检查没跑通：${checked.failed}` };
      // The check says the watch is over: off after this run (a last finding still gets its session).
      if (checked.done) {
        this.turnOff(item.id);
        lastWord = "；检查说这是最后一次，值守已关掉";
      }
      if (checked.found === null) {
        // Nothing now: the next finding starts a session even if it reads like an older one.
        this.setFound(item.id, null);
        return { ok: true, skipped: true, summary: checked.done ? "检查说不用再值守了，已关掉" : "检查过了，没有要做的" };
      }
      if (this.found()[item.id] === checked.found) return { ok: true, skipped: true, summary: `检查结果和上次开会话时一样，不再开${lastWord}` };
      found = checked.found;
      goOnIn = checked.sessionId;
      sessionTitle = checked.title;
      prompt = `${a.prompt}\n\n值守检查发现：\n${found}`;
    }
    if (a.untilDone) prompt += `\n\n（这是值守项「${item.title}」开的会话。它盯的事处理完、不用再值守时，调 AMO 的 duty_stop 关掉它。）`;
    // Kept once a session has it: a skip for the subscription leaves the finding to the next run.
    const started = (result: DutyJobResult): DutyJobResult => {
      if (found !== null) this.setFound(item.id, found);
      return { ...result, summary: result.summary + lastWord };
    };
    let profileId = a.profileId;
    const full = await this.usedUp(profileId);
    let note = "";
    if (full) {
      const fallback = a.fallbackProfileId && !(await this.usedUp(a.fallbackProfileId)) ? a.fallbackProfileId : null;
      if (!fallback) return { ok: true, skipped: true, summary: `额度快用完了（${full}），这次跳过` };
      profileId = fallback;
      note = `（${full}，改用 ${this.requireProfile(fallback).label}）`;
    }
    // The chosen model, effort and permissions are the first profile's; the fallback runs with its own defaults.
    const first = { profileId, text: prompt, ...(profileId === a.profileId && a.options && Object.keys(a.options).length ? { options: a.options } : {}) };
    if (a.taskId) {
      const task = this.store.getTask(a.taskId);
      if (!task || task.archivedAt) return { ok: false, summary: "要开会话的任务已经归档或删掉了" };
      // In another project's folder (2026-10-31, plans/release.md: the day's 维护 task, its 值守 working in the 值守
      // directory), like session_start's workspace: still a session of the task.
      const other = a.workspaceId && a.workspaceId !== task.workspaceId && !task.remote ? this.store.getWorkspace(a.workspaceId) : null;
      if (other === undefined || other?.archivedAt) return { ok: false, summary: "会话要跑的项目已经删掉了" };
      // The person answered on what an older session of this item took: go on there, where the work and its context
      // are (问题 #1's follow-up, the user, 2026-10-31). Only with the item's own model: a fallback starts afresh.
      const older = goOnIn && !note ? this.store.getSession(goOnIn) : undefined;
      if (older && this.sessions()[older.id] === item.id && older.taskId === task.id && !older.archivedAt && !sessionMoving(older) && older.status !== "error") {
        const repliesBefore = this.replies(older.id);
        await this.f.sessions.sendMessage(older.id, prompt);
        return started({ ok: true, summary: `在「${task.title}」的会话「${older.title || "未命名会话"}」里接着做`, sessionId: older.id, taskId: task.id, repliesBefore });
      }
      const session = other
        ? await this.f.tasks.startSession({ taskId: task.id, topicId: null }, other, { ...first, text: `（你在项目「${other.name}」的文件夹 ${other.path} 里工作，和任务本身的项目不同。）\n${first.text}` })
        : await this.f.tasks.addSession(task.id, first);
      // Shown under the session that set the item up, like one it started with session_start (the user, 2026-10-31:
      // "要使用子session的那种方式，挂在值守父任务上"), and named after what it is for.
      const parent = item.setBy ? this.store.getSession(item.setBy) : undefined;
      if (parent && parent.taskId === task.id && parent.kind === "main" && !parent.archivedAt) this.publish({ type: "session.upserted", session: this.store.setSessionStartedBy(session.id, parent.id) });
      // Without a name from the check, the item's (2026-11-01: not the prompt's first line, 「（你在项目…」).
      await this.f.sessions.renameSession(session.id, sessionTitle ?? item.title).catch(() => undefined);
      return started({ ok: true, summary: `在「${task.title}」里开了会话${sessionTitle ? `「${sessionTitle}」` : ""}${note}`, sessionId: session.id, taskId: task.id });
    }
    const stamp = new Date(this.now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const titleText = `${a.taskTitle || item.title} · ${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    const made = await this.f.tasks.createTask({ title: titleText, ...(a.workspaceId ? { workspaceId: a.workspaceId } : {}), firstSession: first });
    if (made.session && sessionTitle) await this.f.sessions.renameSession(made.session.id, sessionTitle).catch(() => undefined);
    return started({ ok: true, summary: `新建任务「${titleText}」${note}`, ...(made.session ? { sessionId: made.session.id } : {}), taskId: made.task.id });
  }

  private async runCommand(item: DutyItem, a: Extract<DutyAction, { kind: "command" }>, signal: AbortSignal): Promise<DutyJobResult> {
    const out = await this.exec(a.command, a.workspaceId, a.timeoutSec ?? DEFAULT_TIMEOUT_SEC, signal);
    if (out.error) return { ok: false, summary: out.error };
    const { done, rest } = doneMark(out.output);
    if (done) this.turnOff(item.id);
    const last = rest.split(/\r?\n/).at(-1)?.trim().slice(0, 200) ?? "";
    return { ok: out.code === 0, summary: `${out.code === 0 ? "完成" : `退出码 ${out.code}`}${done ? "，值守已关掉" : ""}${last ? `：${last}` : ""}` };
  }

  /** A command line in a project's folder (the common folder without one), below normal priority, without Host's variables. */
  private exec(command: string, workspaceId: Id | null | undefined, timeoutSec: number, signal: AbortSignal): Promise<{ code: number | null; output: string; last: string; error?: string }> {
    const ws = workspaceId ? this.store.getWorkspace(workspaceId) : this.commonWorkspace();
    if (!ws) return Promise.resolve({ code: null, output: "", last: "", error: "命令所在的项目不在了" });
    return new Promise((done) => {
      let output = "";
      const child = spawn(command, { cwd: ws.path, shell: true, windowsHide: true, env: withoutHostEnv(process.env) });
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
      const timer = setTimeout(() => kill(timeoutSec < 120 ? `超过 ${timeoutSec} 秒没结束，停掉了` : `超过 ${Math.round(timeoutSec / 60)} 分钟没结束，停掉了`), timeoutSec * 1000);
      timer.unref?.();
      signal.addEventListener("abort", () => kill("Studio 退出或值守项被删，停掉了"), { once: true });
      child.on("error", (err) => {
        clearTimeout(timer);
        done({ code: null, output, last: "", error: `运行不了：${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const last = output.trim().split(/\r?\n/).at(-1)?.trim().slice(0, 200) ?? "";
        done({ code, output, last, ...(why ? { error: why } : {}) });
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

/** A command's output without its AMO_DUTY_DONE lines, and whether it had one. */
function doneMark(output: string): { done: boolean; rest: string } {
  const lines = output.split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== DUTY_DONE_MARK);
  return { done: kept.length !== lines.length, rest: kept.join("\n").trim() };
}
