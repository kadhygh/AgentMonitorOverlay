import { randomBytes } from "node:crypto";
import { NO_REMOTE_ALLOWED, REMOTE_KINDS, REMOTE_PERMISSIONS, RUNTIME_LABELS, type HostEvent, type Id, type ModelProfile, type RemoteAllowed, type RemoteGrant, type RemoteItemsAnswer, type RemoteFileAsk, type RemotePermission, type RemotePush,type RemoteTaskSnapshot, type RemoteTaskView, type SessionItem, type SessionOptions, type Task } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import type { HostService } from "../../service.js";
import { HostError, boundedText } from "../../core/shared.js";
import type { DeviceLink } from "./link.js";
import { attachedPaths, itemForPeer, readRemoteFile, type FileRoots } from "./files.js";

// 远程, step 2 on A (plans/remote-session.md, 2026-10-29): the tasks this computer granted to paired devices, what such
// a device may ask of them, and what A tells it unasked as they change. The grant is the whole task: every session in
// it, delegated sessions and subagents included (「授权范围」). Commands are checked against the grant one by one; a
// device reaches nothing else of this computer — no other task, project, setting or file.

const GRANTS_KEY = "remote.grants";
const ALLOWED_KEY = "remote.allowed";

/** What the remote parts need of the feature that holds the connection. */
export interface RemoteContext {
  host: HostService;
  link(): DeviceLink | null;
  /** This computer's name, for what the other side reads. */
  deviceName(): string;
  /** A paired device's name and whether the server says it is online. */
  peer(ref: DeviceRef, role?: "owner" | "guest"): { name: string; online: boolean } | null;
  changed(): void;
}

export type Answer = { kind: string; body: unknown };

const same = (a: DeviceRef, b: DeviceRef) => a.account === b.account && a.device === b.device;
const ok = (body: unknown): Answer => ({ kind: REMOTE_KINDS.ok, body });
const fail = (code: string, message: string): Answer => ({ kind: "error", body: { code, message } });
const id = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v || v.length > 200) throw new HostError("bad_request", `${name} 不对`);
  return v;
};

/** Biggest piece of items one answer carries (the server passes frames up to 1 MB). */
const ITEMS_BYTES = 600_000;
const ITEMS_MAX = 400;
/** An item bigger than this goes with its long texts cut. */
const ITEM_BYTES = 300_000;
const CUT = 40_000;

/** session_start's permission levels as each runtime's own permission option (as SessionsFeature.startPeer). */
export const PERMISSION_OF: Record<Exclude<ModelProfile["runtime"], "remote">, Record<RemotePermission, string>> = {
  codex: { "read-only": "read-only", write: "workspace-write", full: "full-auto" },
  claude: { "read-only": "plan", write: "acceptEdits", full: "bypassPermissions" },
  dsh: { "read-only": "read-only", write: "workspace-write", full: "full-access" },
};

/** An item small enough for one frame: its long texts cut, saying so. */
export function fitItem(item: SessionItem): SessionItem {
  if (Buffer.byteLength(JSON.stringify(item)) <= ITEM_BYTES) return item;
  const cut = (s: unknown) => (typeof s === "string" && s.length > CUT ? `${s.slice(0, CUT)}\n…（太长，远程只传了前面一部分）` : s);
  const out = { ...item } as Record<string, unknown>;
  for (const k of ["markdown", "text", "detail", "input", "output", "summary", "message"]) if (k in out) out[k] = cut(out[k]);
  if (Array.isArray(out.files)) out.files = (out.files as Array<Record<string, unknown>>).map((f) => ({ ...f, diff: cut(f.diff) }));
  return out as unknown as SessionItem;
}

export class RemoteGrants {
  /** Which task a session is in (sessions never change task): items and deltas are looked up per event. */
  private readonly taskOf = new Map<Id, Id | null>();

  constructor(private readonly ctx: RemoteContext) {}

  private get store() {
    return this.ctx.host.store;
  }

  /** Read once, then kept: every Host event (streamed text too) asks whether its task is granted. */
  private cache: RemoteGrant[] | null = null;

  list(): RemoteGrant[] {
    if (this.cache) return this.cache;
    try {
      const v = JSON.parse(this.store.getKv(GRANTS_KEY)?.value ?? "[]") as RemoteGrant[];
      this.cache = Array.isArray(v) ? v : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private save(list: RemoteGrant[]): void {
    this.store.setKv(GRANTS_KEY, JSON.stringify(list));
    this.cache = list;
  }

  /** The grants of a task (a task can be granted to more than one device). */
  of(taskId: Id): RemoteGrant[] {
    return this.list().filter((g) => g.taskId === taskId);
  }

  allowed(): RemoteAllowed {
    try {
      const v = JSON.parse(this.store.getKv(ALLOWED_KEY)?.value ?? "null") as RemoteAllowed | null;
      if (!v || typeof v !== "object" || !Array.isArray(v.profiles)) return NO_REMOTE_ALLOWED;
      return { profiles: v.profiles.filter((x) => typeof x === "string"), defaultProfile: typeof v.defaultProfile === "string" ? v.defaultProfile : null, permission: REMOTE_PERMISSIONS.includes(v.permission as RemotePermission) ? v.permission : null };
    } catch {
      return NO_REMOTE_ALLOWED;
    }
  }

  setAllowed(input: unknown): RemoteAllowed {
    const b = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (!Array.isArray(b.profiles) || b.profiles.some((p) => typeof p !== "string")) throw new HostError("bad_request", "profiles 要是模型的列表");
    const profiles = [...new Set(b.profiles as string[])];
    for (const p of profiles) if (!this.ctx.host.profiles.some((x) => x.id === p)) throw new HostError("bad_request", `没有模型 ${p}`);
    const defaultProfile = b.defaultProfile === null || b.defaultProfile === undefined || b.defaultProfile === "" ? null : id(b.defaultProfile, "defaultProfile");
    if (defaultProfile && profiles.length && !profiles.includes(defaultProfile)) throw new HostError("bad_request", "默认的模型要在允许的里面");
    const permission = b.permission === null || b.permission === undefined || b.permission === "" ? null : (b.permission as RemotePermission);
    if (permission !== null && !REMOTE_PERMISSIONS.includes(permission)) throw new HostError("bad_request", `permission 只能是 ${REMOTE_PERMISSIONS.join(" / ")}`);
    const next: RemoteAllowed = { profiles, defaultProfile, permission };
    this.store.setKv(ALLOWED_KEY, JSON.stringify(next));
    // What granted tasks may start on changed: the devices hear it.
    for (const g of this.list()) {
      const task = this.store.getTask(g.taskId);
      if (task) this.push(g, this.taskPush(task));
    }
    this.ctx.changed();
    return next;
  }

  /**
   * A's profiles a session started from a paired device may run in this task: those of 设置 → 远程, or (none chosen)
   * those the task's own sessions use. The default first.
   */
  allowedFor(taskId: Id): Id[] {
    const cfg = this.allowed();
    const usable = (pid: Id) => {
      const p = this.ctx.host.profiles.find((x) => x.id === pid);
      return !!p && !p.unavailable;
    };
    const ids = cfg.profiles.length
      ? cfg.profiles.filter(usable)
      : [...new Set(this.store.listSessions({ taskId }).filter((s) => s.kind !== "sub" && s.runtime !== "remote").map((s) => s.profileId))].filter(usable);
    const first = cfg.defaultProfile && ids.includes(cfg.defaultProfile) ? cfg.defaultProfile : null;
    return first ? [first, ...ids.filter((x) => x !== first)] : ids;
  }

  /** The permission a session started for a paired device gets, as its runtime names it; undefined: the model's default. */
  permissionFor(profileId: Id): string | undefined {
    const level = this.allowed().permission;
    const p = this.ctx.host.profiles.find((x) => x.id === profileId);
    return level && p && p.runtime !== "remote" ? PERMISSION_OF[p.runtime][level] : undefined;
  }

  private label(pid: Id): string {
    const p = this.ctx.host.profiles.find((x) => x.id === pid);
    return p ? `${RUNTIME_LABELS[p.runtime]} · ${p.label}` : pid;
  }

  private profilesOf(taskId: Id, allowed: Id[]): Array<{ id: Id; label: string }> {
    const ids = [...new Set([...this.store.listSessions({ taskId }).map((s) => s.profileId), ...allowed])];
    return ids.map((pid) => ({ id: pid, label: this.label(pid) }));
  }

  private view(task: Task): RemoteTaskView {
    return { id: task.id, title: task.title, ...(task.description ? { description: task.description } : {}), column: task.column, createdAt: task.createdAt, updatedAt: task.updatedAt };
  }

  private taskPush(task: Task): RemotePush {
    const allowed = this.allowedFor(task.id);
    return { type: "task", task: this.view(task), profiles: this.profilesOf(task.id, allowed), allowed };
  }

  // ---- granting (设置 → 远程, the task page)

  grant(taskId: Id, peer: DeviceRef): RemoteGrant {
    const task = this.store.getTask(taskId);
    if (!task) throw new HostError("not_found", `没有任务 ${taskId}`);
    if (task.remote) throw new HostError("bad_request", "这是别的电脑授权给这台电脑的远程任务，不能再转授权");
    if (task.archivedAt) throw new HostError("read_only", "任务已归档，不能授权");
    const p = this.ctx.peer(peer, "owner");
    // Only a device this computer allowed to pair may reach it (the owner side, plans/remote-session.md「B 是谁」).
    if (!p) throw new HostError("bad_request", "只能授权给这台电脑允许配对的设备（在 设置 → 远程 里配对）");
    const list = this.list();
    const had = list.find((g) => g.taskId === taskId && same(g, peer));
    if (had) return had;
    const g: RemoteGrant = { taskId, account: peer.account, device: peer.device, name: p.name, grantedAt: new Date().toISOString() };
    this.save([...list, g]);
    this.push(g, { type: "granted", taskId, grantedAt: g.grantedAt });
    this.ctx.changed();
    return g;
  }

  revoke(taskId: Id, peer: DeviceRef, reason: string): boolean {
    const list = this.list();
    const g = list.find((x) => x.taskId === taskId && same(x, peer));
    if (!g) return false;
    this.save(list.filter((x) => x !== g));
    this.push(g, { type: "revoked", taskId, reason });
    this.ctx.changed();
    return true;
  }

  /** Every grant to a device (the pairing ended): gone without a word to it — it is no longer reachable. */
  dropPeer(peer: DeviceRef): RemoteGrant[] {
    const list = this.list();
    const gone = list.filter((g) => same(g, peer));
    if (gone.length) {
      this.save(list.filter((g) => !same(g, peer)));
      this.ctx.changed();
    }
    return gone;
  }

  /** Keeps the names the devices go by now. */
  rename(peer: DeviceRef, name: string): void {
    const list = this.list();
    if (list.some((g) => same(g, peer) && g.name !== name)) this.save(list.map((g) => (same(g, peer) ? { ...g, name } : g)));
  }

  // ---- what a device sends

  private grantFor(from: DeviceRef, taskId: Id): RemoteGrant {
    const g = this.list().find((x) => x.taskId === taskId && same(x, from));
    if (!g) throw new HostError("not_found", "这个任务没有授权给你（可能已经收回）");
    return g;
  }

  private sessionFor(from: DeviceRef, sessionId: Id, write: boolean) {
    const s = this.store.getSession(sessionId);
    if (!s?.taskId) throw new HostError("not_found", "这个会话不在授权的任务里");
    this.grantFor(from, s.taskId);
    if (write) {
      if (s.archivedAt) throw new HostError("read_only", "这个会话已经归档了");
      if (this.store.getTask(s.taskId)?.archivedAt) throw new HostError("read_only", "这个任务已经归档了");
    }
    return s;
  }

  snapshot(from: DeviceRef, taskId: Id): RemoteTaskSnapshot {
    const g = this.grantFor(from, taskId);
    const task = this.store.getTask(taskId);
    if (!task) throw new HostError("not_found", "任务已经不在了");
    const allowed = this.allowedFor(taskId);
    return { task: this.view(task), sessions: this.store.listSessions({ taskId }), profiles: this.profilesOf(taskId, allowed), allowed, grantedAt: g.grantedAt };
  }

  /** The task's folder on this computer (its project's, or the common folder), as the device's paths are named from it. */
  private taskRoot(taskId: Id | null): string | null {
    const task = taskId ? this.store.getTask(taskId) : undefined;
    return task ? (this.store.getWorkspace(task.workspaceId)?.path ?? null) : null;
  }

  /** Step 3: what a file request of a granted task may reach — its folder and the pictures sent in its conversations. */
  private fileRoots(taskId: Id): FileRoots {
    const root = this.taskRoot(taskId);
    if (!root) throw new HostError("not_found", "任务的文件夹不在了");
    return {
      root,
      attachments: this.ctx.host.attachments.dir(),
      attached: () => this.store.listSessions({ taskId }).flatMap((s) => attachedPaths(this.store.listItems(s.id))),
    };
  }

  items(sessionId: Id, since: number): RemoteItemsAnswer {
    const out: SessionItem[] = [];
    let bytes = 0;
    const root = this.taskRoot(this.taskIdOf(sessionId));
    for (const it of this.store.listItems(sessionId, since)) {
      const fitted = itemForPeer(fitItem(it), root);
      const n = Buffer.byteLength(JSON.stringify(fitted));
      if (out.length && (bytes + n > ITEMS_BYTES || out.length >= ITEMS_MAX)) return { items: out, more: true };
      out.push(fitted);
      bytes += n;
    }
    return { items: out, more: false };
  }

  /** One command from a paired device, answered (an error too: it is said, never thrown at the connection). */
  async serve(from: DeviceRef, kind: string, body: unknown): Promise<Answer> {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const sessions = this.ctx.host.sessions;
    try {
      switch (kind) {
        case REMOTE_KINDS.list:
          return ok({ tasks: this.list().filter((g) => same(g, from)).map((g) => ({ taskId: g.taskId, grantedAt: g.grantedAt })) });
        case REMOTE_KINDS.task:
          return ok(this.snapshot(from, id(b.taskId, "taskId")));
        case REMOTE_KINDS.items: {
          const s = this.sessionFor(from, id(b.sessionId, "sessionId"), false);
          return ok(this.items(s.id, typeof b.since === "number" && b.since > 0 ? Math.floor(b.since) : 0));
        }
        case REMOTE_KINDS.send: {
          const s = this.sessionFor(from, id(b.sessionId, "sessionId"), true);
          return ok(await sessions.sendMessage(s.id, boundedText(b.text, "text", 100_000)));
        }
        case REMOTE_KINDS.approve: {
          const s = this.sessionFor(from, id(b.sessionId, "sessionId"), true);
          try {
            await sessions.respondApproval(s.id, id(b.approvalId, "approvalId"), b.decision as never);
          } catch (err) {
            // First come, first served: the other side (or this computer) answered it already.
            if (err instanceof HostError && err.code === "conflict") throw new HostError("conflict", `这个审批已经处理过了（可能在 ${this.ctx.deviceName()} 上先点了）`);
            throw err;
          }
          return ok({ ok: true });
        }
        case REMOTE_KINDS.answer: {
          const s = this.sessionFor(from, id(b.sessionId, "sessionId"), true);
          await sessions.answerQuestion(s.id, id(b.itemId, "itemId"), b.reply);
          return ok({ ok: true });
        }
        case REMOTE_KINDS.interrupt: {
          const s = this.sessionFor(from, id(b.sessionId, "sessionId"), false);
          await sessions.interrupt(s.id);
          return ok({ ok: true });
        }
        case REMOTE_KINDS.start: {
          const taskId = id(b.taskId, "taskId");
          this.grantFor(from, taskId);
          const task = this.store.getTask(taskId);
          if (!task || task.archivedAt) throw new HostError("read_only", "这个任务已经归档了");
          const profileId = id(b.profileId, "profileId");
          if (!this.allowedFor(taskId).includes(profileId)) throw new HostError("bad_request", `${this.label(profileId)} 不在 ${this.ctx.deviceName()} 允许远程使用的模型里`);
          const text = typeof b.text === "string" && b.text.trim() ? boundedText(b.text, "text", 100_000) : undefined;
          const permission = this.permissionFor(profileId);
          const options: SessionOptions | undefined = permission ? { permission } : undefined;
          const session = await this.ctx.host.tasks.addSession(taskId, { profileId, ...(text ? { text } : {}), ...(options ? { options } : {}) });
          return ok({ session: this.store.getSession(session.id) ?? session });
        }
        case REMOTE_KINDS.file: {
          const taskId = id(b.taskId, "taskId");
          this.grantFor(from, taskId);
          return ok(await readRemoteFile(this.fileRoots(taskId), b as unknown as RemoteFileAsk, this.ctx.deviceName()));
        }
        default:
          return fail("unknown_kind", `${this.ctx.deviceName()} 的 Studio 不认识「${kind}」，可能版本不同`);
      }
    } catch (err) {
      if (err instanceof HostError) return fail(err.code, err.message);
      return fail("runtime_error", err instanceof Error ? err.message : String(err));
    }
  }

  // ---- what A tells the devices unasked

  private push(g: RemoteGrant, body: RemotePush): void {
    const link = this.ctx.link();
    // Nobody to tell while the device is away: it asks for everything again when it is back.
    if (!link || link.state !== "online" || !this.ctx.peer(g)?.online) return;
    link.send({ type: "relay", to: { account: g.account, device: g.device }, id: `p_${randomBytes(8).toString("hex")}`, kind: REMOTE_KINDS.push, body });
  }

  private taskIdOf(sessionId: Id): Id | null {
    if (this.taskOf.has(sessionId)) return this.taskOf.get(sessionId)!;
    const t = this.store.getSession(sessionId)?.taskId ?? null;
    this.taskOf.set(sessionId, t);
    return t;
  }

  /** A change on this computer: the devices its task is granted to hear of it. */
  onHostEvent(e: HostEvent): void {
    const grants = this.list();
    if (!grants.length) return;
    const to = (taskId: Id | null) => (taskId ? grants.filter((g) => g.taskId === taskId) : []);
    switch (e.type) {
      case "task.upserted": {
        const gs = to(e.task.id);
        if (!gs.length) return;
        if (e.task.archivedAt) {
          for (const g of gs) this.revoke(g.taskId, g, `任务在 ${this.ctx.deviceName()} 上归档了`);
          return;
        }
        const body = this.taskPush(e.task);
        for (const g of gs) this.push(g, body);
        return;
      }
      case "session.upserted":
        this.taskOf.set(e.session.id, e.session.taskId);
        for (const g of to(e.session.taskId)) this.push(g, { type: "session", session: e.session });
        return;
      case "item.appended":
      case "item.updated": {
        const taskId = this.taskIdOf(e.item.sessionId);
        const gs = to(taskId);
        if (!gs.length) return;
        const item = itemForPeer(fitItem(e.item), this.taskRoot(taskId));
        for (const g of gs) this.push(g, { type: "item", item });
        return;
      }
      case "item.delta":
        for (const g of to(this.taskIdOf(e.sessionId))) this.push(g, { type: "delta", sessionId: e.sessionId, itemId: e.itemId, append: e.append });
        return;
      case "data.purged":
        for (const g of grants.filter((x) => e.taskIds.includes(x.taskId))) this.revoke(g.taskId, g, `任务在 ${this.ctx.deviceName()} 上删除了`);
        return;
      default:
        return;
    }
  }

  /**
   * session_start in a granted task (「授权范围」, 2026-10-29): the new session stays in the task and so in the grant;
   * another project is refused for now, and a model outside what remote sessions may use becomes the default allowed
   * one (`note` says so in the new session). Null: the task is not granted, nothing changes.
   */
  limitDelegation(taskId: Id, input: { profileId: Id; elsewhere: boolean }): { profileId: Id; note: string | null; permission: string | undefined } | null {
    const gs = this.of(taskId);
    if (!gs.length) return null;
    const who = [...new Set(gs.map((g) => g.name))].join("、");
    if (input.elsewhere) throw new HostError("bad_request", `这个任务正授权给 ${who} 远程使用，暂时不能把会话开到别的项目：去掉 workspace，在任务自己的项目里开。`);
    const allowed = this.allowedFor(taskId);
    let profileId = input.profileId;
    let note: string | null = null;
    if (!allowed.includes(profileId)) {
      const fallback = allowed[0];
      if (!fallback) throw new HostError("bad_request", `这个任务正授权给 ${who} 远程使用，${this.label(profileId)} 不在允许远程使用的模型里，也没有可以换的：请人在 设置 → 远程 里允许一个模型。`);
      note = `（这个任务正被 ${who} 远程使用，要的模型 ${this.label(profileId)} 不在允许远程使用的模型里，换成了 ${this.label(fallback)}。）`;
      profileId = fallback;
    }
    return { profileId, note, permission: this.permissionFor(profileId) };
  }
}
