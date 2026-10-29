import { isCommon, NO_REMOTE_PROJECTS, remoteCreateOpen, topicWorkspaceIds, type Id, type RemoteAllowedProjects, type RemoteCatalog, type RemoteCreateAnswer, type Session, type SessionOptions, type Task } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import type { RemoteContext, RemoteGrants } from "./grants.js";

// 远程创建 on A (plans/remote-page-and-new-task.md 4.1, 2026-10-29): a paired device creates a task on this computer from
// its new-task page. The user (10-29): nobody here says yes — 远程设置 limits it instead: 远端允许的项目 (kv
// `remote.allowedProjects`, the whole computer, as 远端允许的模型 is) and 远端允许的模型. Nothing ticked: not available.
// rt.catalog says what the device may pick; rt.create makes the task, grants it and starts its session — the same
// path an allowed request takes (step 4, requests.ts).

const PROJECTS_KEY = "remote.allowedProjects";
const TITLE_MAX = 200;
const TEXT_MAX = 100_000;

export interface GrantedTaskInput {
  title: string;
  /** The task's 说明 (an allowed request puts the request there). */
  description?: string;
  /** The session's first message. */
  text: string;
  /** null: the common folder. */
  workspaceId: Id | null;
  topicId: Id | null;
  /** One of 远端允许的模型. */
  profileId: Id;
}

/**
 * Makes a task for a paired device: in 进行中 (its session starts just below), granted to the device, its session started
 * on the model with 远端允许的模型's permissions and `text` as its first message. `granted` runs between the grant and
 * the session (an allowed request answers the device there). A session that does not start leaves the task and the
 * grant (`error` says why): it can be started on the task page, here or from the device.
 */
export async function startGrantedTask(ctx: RemoteContext, grants: RemoteGrants, to: DeviceRef, input: GrantedTaskInput, granted?: (task: Task) => void): Promise<{ task: Task; session: Session | null; error?: string }> {
  const host = ctx.host;
  const { task } = await host.tasks.createTask({ title: input.title, workspaceId: input.workspaceId, topicId: input.topicId, column: "doing" });
  if (input.description) host.tasks.updateTask(task.id, { description: input.description });
  grants.grant(task.id, to);
  granted?.(task);
  const permission = grants.permissionFor(input.profileId);
  const options: SessionOptions | undefined = permission ? { permission } : undefined;
  try {
    const session = await host.tasks.addSession(task.id, { profileId: input.profileId, text: input.text, ...(options ? { options } : {}) });
    return { task, session };
  } catch (err) {
    return { task, session: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const textOf = (v: unknown, what: string, max: number, required: boolean): string => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t && required) throw new HostError("bad_request", `${what}不能是空的`);
  if (t.length > max) throw new HostError("bad_request", `${what}太长了（${t.length} 个字，最多 ${max}）`);
  return t;
};

export class RemoteCreates {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly grants: RemoteGrants,
  ) {}

  private get store() {
    return this.ctx.host.store;
  }

  allowedProjects(): RemoteAllowedProjects {
    try {
      const v = JSON.parse(this.store.getKv(PROJECTS_KEY)?.value ?? "null") as RemoteAllowedProjects | null;
      if (!v || typeof v !== "object" || !Array.isArray(v.workspaceIds)) return NO_REMOTE_PROJECTS;
      return { workspaceIds: v.workspaceIds.filter((x) => typeof x === "string"), common: v.common === true };
    } catch {
      return NO_REMOTE_PROJECTS;
    }
  }

  setAllowedProjects(input: unknown): RemoteAllowedProjects {
    const b = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (!Array.isArray(b.workspaceIds) || b.workspaceIds.some((x) => typeof x !== "string")) throw new HostError("bad_request", "workspaceIds 要是项目的列表");
    if (b.common !== undefined && typeof b.common !== "boolean") throw new HostError("bad_request", "common 只能是 true 或 false");
    const workspaceIds = [...new Set(b.workspaceIds as string[])];
    for (const id of workspaceIds) {
      const ws = this.store.getWorkspace(id);
      if (!ws || isCommon(ws)) throw new HostError("bad_request", `没有项目 ${id}`);
    }
    const next: RemoteAllowedProjects = { workspaceIds, common: b.common === true };
    this.store.setKv(PROJECTS_KEY, JSON.stringify(next));
    this.ctx.changed();
    return next;
  }

  /** The allowed projects that are still there (an archived one is skipped until it comes back). */
  private liveProjects(): Id[] {
    return this.allowedProjects().workspaceIds.filter((id) => {
      const ws = this.store.getWorkspace(id);
      return !!ws && !ws.archivedAt && !isCommon(ws);
    });
  }

  /** 远端允许的模型 that can run now, the default first (no fallback to a task's own models: there is no task yet). */
  private models(): Id[] {
    const cfg = this.grants.allowed();
    const ids = cfg.profiles.filter((pid) => {
      const p = this.ctx.host.profiles.find((x) => x.id === pid);
      return !!p && !p.unavailable;
    });
    const first = cfg.defaultProfile && ids.includes(cfg.defaultProfile) ? cfg.defaultProfile : null;
    return first ? [first, ...ids.filter((x) => x !== first)] : ids;
  }

  private requireOwner(from: DeviceRef): void {
    if (!this.ctx.peer(from, "owner")) throw new HostError("bad_request", `只有 ${this.ctx.deviceName()} 允许配对的设备才能在它上面建任务`);
  }

  /** rt.catalog: what the device may pick — A's topics, the allowed projects, the common folder, the allowed models. */
  catalog(from: DeviceRef): RemoteCatalog {
    this.requireOwner(from);
    const tasks = this.store.listTasks().filter((t) => !t.archivedAt && !t.remote);
    const workspaces = this.store.listWorkspaces();
    const last = new Map<Id, string>();
    const touch = (id: Id | null, at: string) => {
      if (id && (last.get(id) ?? "") < at) last.set(id, at);
    };
    for (const t of tasks) {
      touch(t.workspaceId, t.updatedAt);
      touch(t.topicId, t.updatedAt);
    }
    const byLast = <T extends { lastUsed: string | null }>(list: T[]) => list.sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""));
    const allowed = new Set(this.liveProjects());
    const projects = byLast(
      [...allowed].map((id) => ({ id, name: this.store.getWorkspace(id)!.name, lastUsed: last.get(id) ?? null })),
    );
    const topics = byLast(
      this.store
        .listTopics()
        .filter((t) => !t.archivedAt)
        .map((t) => ({ id: t.id, title: t.title, workspaceIds: topicWorkspaceIds(t, tasks, workspaces).filter((id) => allowed.has(id)), lastUsed: last.get(t.id) ?? null })),
    );
    return { name: this.ctx.deviceName(), topics, projects, allowCommon: this.allowedProjects().common, models: this.models().map((id) => ({ id, label: this.grants.labelOf(id) })) };
  }

  /** rt.create: checked against 远端允许的项目 and 远端允许的模型, then made, granted and started. */
  async create(from: DeviceRef, body: Record<string, unknown>): Promise<RemoteCreateAnswer> {
    this.requireOwner(from);
    const name = this.ctx.deviceName();
    if (!remoteCreateOpen({ workspaceIds: this.liveProjects(), common: this.allowedProjects().common })) throw new HostError("bad_request", `${name} 还没勾远端允许的项目：在那台电脑的 远程 → 远程设置 里勾`);
    const text = textOf(body.text, "第一句话", TEXT_MAX, true);
    const title = textOf(body.title, "任务名", TITLE_MAX, false) || text.slice(0, 60);
    let workspaceId: Id | null = null;
    if (body.workspaceId === null || body.workspaceId === undefined || body.workspaceId === "") {
      if (!this.allowedProjects().common) throw new HostError("bad_request", `${name} 不允许远程任务不选项目（公共文件夹）：选一个项目`);
    } else {
      if (typeof body.workspaceId !== "string" || !this.liveProjects().includes(body.workspaceId)) throw new HostError("bad_request", `这个项目不在 ${name} 远端允许的项目里（可能刚被取消勾选）`);
      workspaceId = body.workspaceId;
    }
    let topicId: Id | null = null;
    if (body.topicId !== null && body.topicId !== undefined && body.topicId !== "") {
      const topic = typeof body.topicId === "string" ? this.store.getTopic(body.topicId) : undefined;
      if (!topic || topic.archivedAt) throw new HostError("not_found", `${name} 上没有这个专题了（可能刚归档）`);
      topicId = topic.id;
    }
    if (!this.grants.allowed().profiles.length) throw new HostError("bad_request", `${name} 还没勾远端允许的模型：在那台电脑的 远程 → 远程设置 里勾`);
    const profileId = typeof body.profileId === "string" ? body.profileId : "";
    if (!this.models().includes(profileId)) throw new HostError("bad_request", `这个模型不在 ${name} 远端允许的模型里（或现在用不了）`);
    const made = await startGrantedTask(this.ctx, this.grants, from, { title, text, workspaceId, topicId, profileId });
    return { taskId: made.task.id, sessionId: made.session?.id ?? null, ...(made.error ? { error: made.error } : {}) };
  }
}
