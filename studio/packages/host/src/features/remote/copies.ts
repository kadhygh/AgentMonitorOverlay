import { REMOTE_KINDS, parseRemoteProfileId, remoteProfileId, type ApprovalDecision, type Id, type ModelProfile, type NewSessionInput, type QuestionReply, type RemoteItemsAnswer, type RemoteListAnswer, type RemotePush, type RemoteTaskSnapshot, type Session, type SessionItem, type Task, type TaskRemote } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import type { HostErrorCode } from "@amo-studio/protocol";
import type { HostEventInput } from "../../store/store.js";
import { CommandError } from "./link.js";
import type { RemoteContext } from "./grants.js";
import { RemoteFiles } from "./files.js";

// 远程, step 2 on B (plans/remote-session.md, 2026-10-29): this computer's copies of the tasks paired devices granted
// it. A copy is an ordinary task of this Host (in the common space, Task.remote saying where it runs) with sessions whose
// runtime is "remote", under A's own ids: the board, the task page, the conversation and Focus show it like any other.
// A is the original: what B does to it goes there as a command, and what A has comes back — pushed as it happens, and
// asked for again (by each session's seq, from its oldest unfinished item) whenever A or this computer reconnects.
// Nothing is sent again on its own: a command without an answer is「结果未确认」until the copy is checked again.

const DISMISSED_KEY = "remote.dismissed";

const same = (a: DeviceRef, b: DeviceRef) => a.account === b.account && a.device === b.device;
const peerOf = (t: Task): DeviceRef => ({ account: t.remote!.account, device: t.remote!.device });

/** How long a command may take before its result counts as unconfirmed. Starting a session takes longest. */
const COMMAND_MS = 30_000;
const START_MS = 90_000;

export class RemoteCopies {
  private readonly fetching = new Set<Id>();
  private readonly again = new Set<Id>();
  private readonly syncing = new Map<string, Promise<void>>();

  /** Step 3: the files fetched from A for the copies (thrown away with a copy). */
  readonly files: RemoteFiles;
  /** Step 4: what A's list says besides its grants (this computer's requests to it). */
  onList: ((peer: DeviceRef, list: RemoteListAnswer) => void) | null = null;

  constructor(private readonly ctx: RemoteContext) {
    this.files = new RemoteFiles(ctx, (peer, kind, body, timeoutMs, offline) => this.ask(peer, kind, body, timeoutMs, offline));
  }

  private get store() {
    return this.ctx.host.store;
  }

  private publish(e: HostEventInput): void {
    this.ctx.host.publish(e);
  }

  /** This computer's copies (of one device, or all), archived ones too. */
  copies(peer?: DeviceRef): Task[] {
    return this.store.listTasks().filter((t) => t.remote && (!peer || same(t.remote, peer)));
  }

  /** The models copies show, as profiles of this Host: hidden from every picker, there for the names. */
  profiles(): ModelProfile[] {
    const seen = new Map<Id, ModelProfile>();
    for (const t of this.copies()) for (const p of t.remote!.profiles) if (!seen.has(p.id)) seen.set(p.id, { id: p.id, label: p.label, runtime: "remote", provider: null, model: null, hidden: true });
    return [...seen.values()];
  }

  private profilesChanged(before: string): void {
    const after = JSON.stringify(this.profiles().map((p) => [p.id, p.label]));
    if (after !== before) this.publish({ type: "profiles.updated", profiles: this.ctx.host.allProfiles() });
  }
  private profilesStamp = () => JSON.stringify(this.profiles().map((p) => [p.id, p.label]));

  // ---- asking A

  /** A command to A and its answer; `offline`: what to say when A is not online (default: about sending). */
  async ask<T>(peer: DeviceRef, kind: string, body: unknown, timeoutMs = COMMAND_MS, offline?: string): Promise<T> {
    const name = this.ctx.peer(peer)?.name ?? peer.account;
    const link = this.ctx.link();
    if (!link || link.state !== "online") throw new HostError("runtime_error", "这台电脑没有连上团队服务器，回来后再试");
    let f;
    try {
      f = await link.request(peer, kind, body, timeoutMs);
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      if (err.code === "offline") throw new HostError("runtime_error", offline ?? `${name} 离线，回来后再发`);
      if (err.code === "not_paired") throw new HostError("read_only", `已经不和 ${name} 配对了`);
      if (err.code === "unconfirmed" || err.code === "timeout") throw new HostError("runtime_error", `结果未确认：连接断了或 ${name} 没有及时回音。重连后核对（不会自动重发）`);
      throw new HostError("runtime_error", err.message);
    }
    if (f.kind === "error") {
      const e = (f.body ?? {}) as { code?: string; message?: string };
      // A command A's Studio does not know yet (远程创建's rt.catalog / rt.create, 2026-10-29): say what to do.
      if (e.code === "unknown_kind") throw new HostError("runtime_error", `${name} 上的 Studio 版本太旧，先在那台电脑上更新`);
      const code: HostErrorCode = e.code === "not_found" || e.code === "bad_request" || e.code === "conflict" || e.code === "read_only" ? e.code : "runtime_error";
      throw new HostError(code, e.message ?? `${name} 回了一个错误`);
    }
    return f.body as T;
  }

  // ---- bringing copies up to date

  /** Everything granted by one device, again: new grants, grants taken back, every session's missed items. */
  syncPeer(peer: DeviceRef): Promise<void> {
    const key = `${peer.account}\n${peer.device}`;
    const running = this.syncing.get(key);
    if (running) return running;
    const run = (async () => {
      let list: RemoteListAnswer;
      try {
        list = await this.ask<RemoteListAnswer>(peer, REMOTE_KINDS.list, {});
      } catch {
        // Not reachable now: nothing changes; the next reconnect asks again.
        return;
      }
      this.onList?.(peer, list);
      const granted = new Map(list.tasks.map((t) => [t.taskId, t.grantedAt]));
      for (const t of this.copies(peer)) if (t.remote!.state === "active" && !t.archivedAt && !granted.has(t.id)) this.revokeCopy(t.id, "授权已收回");
      for (const [taskId, grantedAt] of granted) {
        // Put away here while A was away (or from before A knew rt.drop): A hears it now.
        if (this.dismissed(peer, taskId, grantedAt)) {
          this.tellDropped(peer, taskId);
          continue;
        }
        await this.syncTask(peer, taskId).catch((err: unknown) => this.ctx.host.emit("event", { type: "host.error", message: `远程任务同步失败：${err instanceof Error ? err.message : String(err)}`, seq: this.store.lastEventSeq() }));
      }
    })().finally(() => this.syncing.delete(key));
    this.syncing.set(key, run);
    return run;
  }

  /** One granted task: its copy made or brought up to date, with its sessions and their items. */
  async syncTask(peer: DeviceRef, taskId: Id): Promise<void> {
    const snap = await this.ask<RemoteTaskSnapshot>(peer, REMOTE_KINDS.task, { taskId });
    if (this.dismissed(peer, taskId, snap.grantedAt)) return;
    const existing = this.store.getTask(taskId);
    // A task of this computer's own under the same id: never overwritten (ids are random; this should not happen).
    if (existing && (!existing.remote || !same(existing.remote, peer))) return;
    const before = this.profilesStamp();
    const remote: TaskRemote = {
      account: peer.account,
      device: peer.device,
      name: this.ctx.peer(peer)?.name ?? existing?.remote?.name ?? peer.account,
      state: "active",
      profiles: snap.profiles.map((p) => ({ id: remoteProfileId(peer.device, p.id), label: p.label })),
      allowed: snap.allowed.map((p) => remoteProfileId(peer.device, p)),
      grantedAt: snap.grantedAt,
    };
    let task: Task;
    if (!existing) {
      task = this.store.createTask({ id: taskId, title: snap.task.title, workspaceId: this.ctx.host.commonWorkspace().id, column: snap.task.column, remote });
      if (snap.task.description) task = this.store.updateTask(taskId, { description: snap.task.description });
    } else {
      task = this.store.updateTask(taskId, { title: snap.task.title, column: snap.task.column, description: snap.task.description ?? "", remote });
    }
    this.publish({ type: "task.upserted", task });
    this.profilesChanged(before);
    // Parents first (a fork or subagent points at its parent).
    const pending = [...snap.sessions];
    for (let guard = 0; pending.length && guard < 1000; guard++) {
      const i = pending.findIndex((s) => !s.parentId || !!this.store.getSession(s.parentId));
      if (i < 0) break;
      this.putSession(peer, pending.splice(i, 1)[0]!);
    }
    for (const s of snap.sessions) await this.catchUp(peer, s.id);
  }

  /** A's session as this computer keeps it. */
  private putSession(peer: DeviceRef, s: Session): Session {
    const copy: Session = {
      ...s,
      runtime: "remote",
      profileId: remoteProfileId(peer.device, s.profileId),
      workspaceId: this.ctx.host.commonWorkspace().id,
      runtimeRef: s.runtimeRef ? `${peer.device}:${s.runtimeRef}` : null,
    };
    const stored = this.store.putRemoteSession(copy);
    this.publish({ type: "session.upserted", session: stored });
    return stored;
  }

  /** Where to ask a session's items from: after the last one, or before the oldest still under way (it may have changed). */
  private catchUpFrom(sessionId: Id): number {
    const last = this.store.lastItemSeq(sessionId);
    const open = this.store.listUnfinishedItems(sessionId);
    return open.length ? Math.min(last, open[0]!.seq - 1) : last;
  }

  /** The items of a session A has and this computer has not (or had while they were still under way). */
  async catchUp(peer: DeviceRef, sessionId: Id): Promise<void> {
    if (this.fetching.has(sessionId)) {
      this.again.add(sessionId);
      return;
    }
    this.fetching.add(sessionId);
    try {
      do {
        this.again.delete(sessionId);
        let since = this.catchUpFrom(sessionId);
        for (;;) {
          const r = await this.ask<RemoteItemsAnswer>(peer, REMOTE_KINDS.items, { sessionId, since });
          for (const item of r.items) this.putItem(item);
          if (!r.more || !r.items.length) break;
          since = r.items[r.items.length - 1]!.seq;
        }
      } while (this.again.has(sessionId));
    } finally {
      this.fetching.delete(sessionId);
    }
  }

  private putItem(item: SessionItem): void {
    const { item: stored, added } = this.store.putRemoteItem(item);
    this.publish({ type: added ? "item.appended" : "item.updated", item: stored });
  }

  /** The copy of a session of `peer`'s, while its task is still granted. */
  private liveCopy(peer: DeviceRef, sessionId: Id): Session | null {
    const s = this.store.getSession(sessionId);
    if (!s || s.runtime !== "remote" || !s.taskId) return null;
    const t = this.store.getTask(s.taskId);
    return t?.remote && same(t.remote, peer) && t.remote.state === "active" && !t.archivedAt ? s : null;
  }

  /** What A pushed. Anything that cannot be placed (a gap in seq, a session not seen yet) makes B ask for it. */
  apply(peer: DeviceRef, body: unknown): void {
    const p = body as RemotePush;
    if (!p || typeof p !== "object" || typeof p.type !== "string") return;
    const later = (fn: () => Promise<unknown>) => void fn().catch(() => undefined);
    switch (p.type) {
      case "granted":
        if (!this.dismissed(peer, p.taskId, p.grantedAt)) later(() => this.syncTask(peer, p.taskId));
        return;
      case "revoked": {
        const t = this.store.getTask(p.taskId);
        if (t?.remote && same(t.remote, peer)) this.revokeCopy(t.id, p.reason || "授权已收回");
        return;
      }
      case "task": {
        const t = this.store.getTask(p.task.id);
        if (!t?.remote || !same(t.remote, peer)) return void later(() => this.syncTask(peer, p.task.id));
        if (t.remote.state !== "active" || t.archivedAt) return;
        const before = this.profilesStamp();
        const remote: TaskRemote = { ...t.remote, profiles: p.profiles.map((x) => ({ id: remoteProfileId(peer.device, x.id), label: x.label })), allowed: p.allowed.map((x) => remoteProfileId(peer.device, x)) };
        this.publish({ type: "task.upserted", task: this.store.updateTask(t.id, { title: p.task.title, column: p.task.column, description: p.task.description ?? "", remote }) });
        this.profilesChanged(before);
        return;
      }
      case "session": {
        const taskId = p.session.taskId;
        const t = taskId ? this.store.getTask(taskId) : undefined;
        if (!t?.remote || !same(t.remote, peer) || t.remote.state !== "active" || t.archivedAt) return;
        // A session on a model the copy does not name yet, or whose parent is not here: the whole task again.
        const known = t.remote.profiles.some((x) => x.id === remoteProfileId(peer.device, p.session.profileId));
        if (!known || (p.session.parentId && !this.store.getSession(p.session.parentId))) return void later(() => this.syncTask(peer, t.id));
        this.putSession(peer, p.session);
        return;
      }
      case "item": {
        const s = this.liveCopy(peer, p.item.sessionId);
        if (!s) return;
        const last = this.store.lastItemSeq(s.id);
        if (this.store.getItem(p.item.id) || p.item.seq === last + 1) this.putItem(p.item);
        else if (p.item.seq > last + 1) later(() => this.catchUp(peer, s.id));
        return;
      }
      case "delta":
        if (this.liveCopy(peer, p.sessionId) && this.store.getItem(p.itemId)) this.ctx.host.emit("event", { type: "item.delta", sessionId: p.sessionId, itemId: p.itemId, append: p.append, seq: this.store.lastEventSeq() });
        return;
      default:
        return;
    }
  }

  revokeCopy(taskId: Id, reason: string): void {
    const t = this.store.getTask(taskId);
    if (!t?.remote || t.remote.state === "revoked") return;
    this.publish({ type: "task.upserted", task: this.store.updateTask(taskId, { remote: { ...t.remote, state: "revoked", reason } }) });
  }

  /** The pairing ended: every copy of that device's is revoked (readable until archived). */
  revokePeer(peer: DeviceRef, reason: string): void {
    for (const t of this.copies(peer)) this.revokeCopy(t.id, reason);
  }

  /** Keeps the names the devices go by now. */
  rename(peer: DeviceRef, name: string): void {
    for (const t of this.copies(peer)) if (t.remote!.name !== name) this.publish({ type: "task.upserted", task: this.store.updateTask(t.id, { remote: { ...t.remote!, name } }) });
  }

  // ---- archiving a copy: it goes from this computer (the task stays on A)

  private dismissedList(): string[] {
    try {
      const v = JSON.parse(this.store.getKv(DISMISSED_KEY)?.value ?? "[]") as string[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private dismissed(peer: DeviceRef, taskId: Id, grantedAt: string): boolean {
    return this.dismissedList().includes(`${peer.account}\n${peer.device}\n${taskId}\n${grantedAt}`);
  }

  /**
   * 归档 on a copy (2026-10-29): the copy and everything of it is deleted here. While the grant lasts, that grant is
   * remembered as put away, so the next sync does not bring it back; a new grant from A does.
   */
  drop(task: Task): void {
    const r = task.remote;
    if (!r) return;
    if (r.state === "active") {
      this.store.setKv(DISMISSED_KEY, JSON.stringify([...this.dismissedList(), `${r.account}\n${r.device}\n${task.id}\n${r.grantedAt}`].slice(-500)));
      // A hears it and ends the grant, so it stops sending what happens in the task; away now, it hears at the next sync.
      this.tellDropped(peerOf(task), task.id);
    }
    const before = this.profilesStamp();
    const sessionIds = this.store.listSessions({ taskId: task.id }).map((s) => s.id);
    this.store.purge({ sessionIds, taskIds: [task.id], topicIds: [], workspaceIds: [] });
    this.publish({ type: "data.purged", workspaceIds: [], topicIds: [], taskIds: [task.id], sessionIds });
    this.profilesChanged(before);
    // The files fetched for it go too (plans/remote-session.md: 归档时一起清掉).
    this.files.drop(task.id);
  }

  private tellDropped(peer: DeviceRef, taskId: Id): void {
    void this.ask(peer, REMOTE_KINDS.drop, { taskId }).catch(() => undefined);
  }

  // ---- what the person does in a copy, sent to A

  /** The copy's task and device, checked to be usable now. */
  private target(sessionId: Id): { task: Task; peer: DeviceRef } {
    const s = this.store.getSession(sessionId);
    const task = s?.taskId ? this.store.getTask(s.taskId) : undefined;
    if (!s || !task?.remote) throw new HostError("not_found", `session ${sessionId} not found`);
    if (task.remote.state !== "active") throw new HostError("read_only", `授权已收回：${task.remote.reason ?? ""}`.replace(/：$/, ""));
    return { task, peer: peerOf(task) };
  }

  async send(sessionId: Id, text: string, images: readonly unknown[]): Promise<{ mode: SendMode }> {
    if (images.length) throw new HostError("bad_request", "远程任务暂时不能从这台电脑发图片和文件过去，只能发文字");
    const { peer } = this.target(sessionId);
    return this.ask<{ mode: SendMode }>(peer, REMOTE_KINDS.send, { sessionId, text });
  }

  async approve(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const { peer } = this.target(sessionId);
    await this.ask(peer, REMOTE_KINDS.approve, { sessionId, approvalId, decision });
  }

  async answer(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const { peer } = this.target(sessionId);
    await this.ask(peer, REMOTE_KINDS.answer, { sessionId, itemId, reply });
  }

  async interrupt(sessionId: Id): Promise<void> {
    const { peer } = this.target(sessionId);
    await this.ask(peer, REMOTE_KINDS.interrupt, { sessionId });
  }

  /** 新会话 in a copy: on A, on a model A allows (the first message goes with it); the copy of it comes back. */
  async start(task: Task, input: NewSessionInput): Promise<Session> {
    const r = task.remote!;
    if (r.state !== "active") throw new HostError("read_only", "授权已收回，不能再开会话");
    if (input.attachments?.length) throw new HostError("bad_request", "远程任务暂时不能从这台电脑发图片和文件过去，只能发文字");
    const ref = parseRemoteProfileId(input.profileId);
    if (!ref || ref.device !== r.device || !r.allowed.includes(input.profileId)) throw new HostError("bad_request", `这个模型不在 ${r.name} 允许远程使用的模型里`);
    const peer = peerOf(task);
    const { session } = await this.ask<{ session: Session }>(peer, REMOTE_KINDS.start, { taskId: task.id, profileId: ref.profileId, ...(input.text?.trim() ? { text: input.text } : {}) }, START_MS);
    const copy = this.store.getSession(session.id) ?? this.putSession(peer, session);
    void this.catchUp(peer, session.id).catch(() => undefined);
    return copy;
  }
}
