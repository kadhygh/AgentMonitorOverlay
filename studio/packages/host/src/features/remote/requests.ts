import { randomBytes } from "node:crypto";
import { REMOTE_KINDS, TASK_DESCRIPTION_MAX, type Id, type RemoteAcceptInput, type RemotePush, type RemoteTaskRequest, type SessionOptions } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import type { RemoteContext, RemoteGrants } from "./grants.js";

// 远程, step 4 (plans/remote-session.md, 2026-10-29): B asks A to run a task. B writes a title and what to do; A's
// person sees it on Focus and in 设置 → 远程, picks the project, the topic (or none) and a model from 远端允许的模型,
// and allows it: A makes the task (its 说明 the request), grants it to B, and starts its session with the request as
// the first message — B's board shows the task and it running. Or A refuses it, saying why. A request goes only while A
// is online: the team server keeps no task contents, and nothing is sent again later on its own.

const REQUESTS_KEY = "remote.taskRequests";
const ASKS_KEY = "remote.asks";
const HIDDEN_KEY = "remote.asks.hidden";
/** Answered requests are kept this long on A (for a device that was away when the answer came). */
const KEEP_ANSWERED_MS = 7 * 24 * 60 * 60_000;
const TITLE_MAX = 200;
const TEXT_MAX = 100_000;
const REASON_MAX = 500;
const REQUEST_ID = /^rq_[\w-]{6,60}$/;

const same = (a: DeviceRef, b: DeviceRef) => a.account === b.account && a.device === b.device;
const text = (v: unknown, what: string, max: number): string => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new HostError("bad_request", `${what}不能是空的`);
  if (t.length > max) throw new HostError("bad_request", `${what}太长了（${t.length} 个字，最多 ${max}）`);
  return t;
};

function readList(ctx: RemoteContext, key: string): RemoteTaskRequest[] {
  try {
    const v = JSON.parse(ctx.host.store.getKv(key)?.value ?? "[]") as RemoteTaskRequest[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** On A: the requests paired devices sent this computer. */
export class TaskRequests {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly grants: RemoteGrants,
  ) {}

  private all(): RemoteTaskRequest[] {
    const now = Date.now();
    return readList(this.ctx, REQUESTS_KEY).filter((r) => r.state === "pending" || now - Date.parse(r.answeredAt ?? r.createdAt) < KEEP_ANSWERED_MS);
  }

  private save(list: RemoteTaskRequest[]): void {
    this.ctx.host.store.setKv(REQUESTS_KEY, JSON.stringify(list));
  }

  /** Waiting for this computer's person (Focus, 设置 → 远程). */
  pending(): RemoteTaskRequest[] {
    return this.all().filter((r) => r.state === "pending");
  }

  /** A device's requests, answered ones too (it asks for them when it comes back: rt.list). */
  of(from: DeviceRef): RemoteTaskRequest[] {
    return this.all().filter((r) => same(r, from));
  }

  /** rt.request: a device that may reach this computer (it allowed the pairing) asks for a task. Same id twice: one request. */
  receive(from: DeviceRef, body: Record<string, unknown>): RemoteTaskRequest {
    const p = this.ctx.peer(from, "owner");
    if (!p) throw new HostError("bad_request", "只有这台电脑允许配对的设备才能请它跑任务");
    const id = typeof body.id === "string" && REQUEST_ID.test(body.id) ? body.id : null;
    if (!id) throw new HostError("bad_request", "请求的编号不对");
    const list = this.all();
    const had = list.find((r) => r.id === id && same(r, from));
    if (had) return had;
    const request: RemoteTaskRequest = { id, title: text(body.title, "标题", TITLE_MAX), text: text(body.text, "要做的事", TEXT_MAX), account: from.account, device: from.device, name: p.name, state: "pending", createdAt: new Date().toISOString() };
    this.save([...list, request]);
    this.ctx.changed();
    return request;
  }

  /** rt.withdraw: the device takes its request back, or puts this computer's answer away. */
  withdraw(from: DeviceRef, requestId: unknown): void {
    const list = this.all();
    const r = list.find((x) => x.id === requestId && same(x, from));
    if (!r) return;
    this.save(list.filter((x) => x !== r));
    if (r.state === "pending") this.ctx.changed();
  }

  private take(id: Id): RemoteTaskRequest {
    const r = this.all().find((x) => x.id === id);
    if (!r) throw new HostError("not_found", "没有这个请求（可能已经撤回了）");
    if (r.state !== "pending") throw new HostError("conflict", r.state === "accepted" ? "这个请求已经同意过了" : "这个请求已经拒绝了");
    return r;
  }

  private answer(r: RemoteTaskRequest, patch: Partial<RemoteTaskRequest>): RemoteTaskRequest {
    const next: RemoteTaskRequest = { ...r, ...patch, answeredAt: new Date().toISOString() };
    this.save(this.all().map((x) => (x.id === r.id && same(x, r) ? next : x)));
    this.push(r, { type: "request", request: next });
    this.ctx.changed();
    return next;
  }

  /**
   * Allowed: the task where the person put it (its title and 说明 from the request), granted to the device, and its
   * session started on the model picked — one of 远端允许的模型, with their permissions — with the request as its first
   * message. The device's board shows it once granted, and the session as it starts.
   */
  async accept(id: Id, input: RemoteAcceptInput): Promise<RemoteTaskRequest> {
    const r = this.take(id);
    const peer = this.ctx.peer(r, "owner");
    if (!peer) throw new HostError("bad_request", `已经不和 ${r.name} 配对了，不能授权给它`);
    const host = this.ctx.host;
    if (typeof input?.workspaceId !== "string" || !input.workspaceId) throw new HostError("bad_request", "先选一个项目（或公共目录）");
    if (typeof input.profileId !== "string" || !input.profileId) throw new HostError("bad_request", "先选一个模型");
    const allowed = this.grants.allowed();
    if (!allowed.profiles.length) throw new HostError("bad_request", "还没有选远端允许的模型：先在 设置 → 远程「远端允许的模型」里勾上可以给远程任务用的模型");
    const profile = host.profiles.find((p) => p.id === input.profileId);
    if (!allowed.profiles.includes(input.profileId) || !profile || profile.unavailable) throw new HostError("bad_request", "这个模型不在远端允许的模型里（或现在用不了）");
    const topicId = typeof input.topicId === "string" && input.topicId ? input.topicId : null;
    // 进行中 from the start, as a task made with its first session is (the session starts just below, once granted).
    const { task } = await host.tasks.createTask({ title: r.title, workspaceId: input.workspaceId, topicId, column: "doing" });
    host.tasks.updateTask(task.id, { description: r.text.length > TASK_DESCRIPTION_MAX ? `${r.text.slice(0, TASK_DESCRIPTION_MAX - 1)}…` : r.text });
    this.grants.grant(task.id, { account: r.account, device: r.device });
    const permission = this.grants.permissionFor(input.profileId);
    const options: SessionOptions | undefined = permission ? { permission } : undefined;
    const answered = this.answer(r, { state: "accepted", taskId: task.id });
    try {
      await host.tasks.addSession(task.id, { profileId: input.profileId, text: r.text, ...(options ? { options } : {}) });
    } catch (err) {
      // The task and the grant stay: its session can be started on the task page (here or from the device).
      host.emit("event", { type: "host.error", message: `远程请求的任务已经建好，但会话没能启动：${err instanceof Error ? err.message : String(err)}`, seq: host.store.lastEventSeq() });
    }
    return answered;
  }

  refuse(id: Id, reason: unknown): RemoteTaskRequest {
    const r = this.take(id);
    const why = typeof reason === "string" ? reason.trim().slice(0, REASON_MAX) : "";
    return this.answer(r, { state: "refused", ...(why ? { reason: why } : {}) });
  }

  /** The pairing ended: its requests go too. */
  dropPeer(peer: DeviceRef): void {
    const list = this.all();
    if (list.some((r) => same(r, peer))) {
      this.save(list.filter((r) => !same(r, peer)));
      this.ctx.changed();
    }
  }

  private push(to: DeviceRef, body: RemotePush): void {
    const link = this.ctx.link();
    // Away: it hears the answer when it is back (rt.list carries its requests).
    if (!link || link.state !== "online" || !this.ctx.peer(to)?.online) return;
    link.send({ type: "relay", to: { account: to.account, device: to.device }, id: `p_${randomBytes(8).toString("hex")}`, kind: REMOTE_KINDS.push, body });
  }
}

type Ask = <T>(peer: DeviceRef, kind: string, body: unknown, timeoutMs?: number, offline?: string) => Promise<T>;

/** On B: what this computer asked paired devices to run. */
export class TaskAsks {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly ask: Ask,
  ) {}

  private hidden(): string[] {
    try {
      const v = JSON.parse(this.ctx.host.store.getKv(HIDDEN_KEY)?.value ?? "[]") as string[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  list(): RemoteTaskRequest[] {
    const hidden = new Set(this.hidden());
    return readList(this.ctx, ASKS_KEY).filter((r) => !hidden.has(r.id));
  }

  private save(list: RemoteTaskRequest[]): void {
    this.ctx.host.store.setKv(ASKS_KEY, JSON.stringify(list));
    this.ctx.changed();
  }

  /** Asks `to` (a device that allowed this computer) to run a task: only while it is online (nothing keeps it meanwhile). */
  async send(to: DeviceRef, titleIn: unknown, textIn: unknown): Promise<RemoteTaskRequest> {
    const p = this.ctx.peer(to, "guest");
    if (!p) throw new HostError("bad_request", "只能请允许了这台电脑配对的设备跑任务");
    const title = text(titleIn, "标题", TITLE_MAX);
    const what = text(textIn, "要做的事", TEXT_MAX);
    if (!p.online) throw new HostError("runtime_error", `${p.name} 不在线，请求没发出去（团队服务器不替你存请求，等它在线再发）`);
    const id = `rq_${randomBytes(9).toString("base64url")}`;
    const { request } = await this.ask<{ request: RemoteTaskRequest }>(to, REMOTE_KINDS.request, { id, title, text: what }, 30_000, `${p.name} 不在线，请求没发出去`);
    // As B keeps it: the device asked.
    const mine: RemoteTaskRequest = { ...request, account: to.account, device: to.device, name: p.name };
    this.save([...readList(this.ctx, ASKS_KEY).filter((r) => r.id !== id), mine]);
    return mine;
  }

  /** Takes a waiting request back (A must hear it: online only), or puts an answer away (here at once; A when it can). */
  async withdraw(id: string): Promise<void> {
    const all = readList(this.ctx, ASKS_KEY);
    const r = all.find((x) => x.id === id);
    if (!r) throw new HostError("not_found", "没有这个请求");
    const peer: DeviceRef = { account: r.account, device: r.device };
    if (r.state === "pending") {
      const name = this.ctx.peer(peer)?.name ?? r.name;
      await this.ask(peer, REMOTE_KINDS.withdraw, { requestId: id }, 30_000, `${name} 不在线，撤回没发出去`);
      this.save(all.filter((x) => x.id !== id));
      return;
    }
    this.ctx.host.store.setKv(HIDDEN_KEY, JSON.stringify([...this.hidden(), id].slice(-500)));
    this.save(all.filter((x) => x.id !== id));
    void this.ask(peer, REMOTE_KINDS.withdraw, { requestId: id }).catch(() => undefined);
  }

  /** A's answer pushed, or its list after a reconnect (authoritative for that device). */
  apply(from: DeviceRef, request: RemoteTaskRequest): void {
    if (!request || typeof request.id !== "string" || this.hidden().includes(request.id)) return;
    const name = this.ctx.peer(from)?.name ?? request.name;
    const mine: RemoteTaskRequest = { ...request, account: from.account, device: from.device, name };
    const all = readList(this.ctx, ASKS_KEY);
    this.save([...all.filter((x) => !(x.id === request.id && same(x, from))), mine]);
  }

  sync(from: DeviceRef, requests: RemoteTaskRequest[] | undefined): void {
    // An older A says nothing about requests: leave them.
    if (!requests) return;
    const hidden = new Set(this.hidden());
    const name = this.ctx.peer(from)?.name;
    const theirs = requests.filter((r) => !hidden.has(r.id)).map((r) => ({ ...r, account: from.account, device: from.device, name: name ?? r.name }));
    const all = readList(this.ctx, ASKS_KEY);
    const next = [...all.filter((x) => !same(x, from)), ...theirs];
    if (JSON.stringify(next) !== JSON.stringify(all)) this.save(next);
  }

  /** The pairing ended: requests to that device go. */
  dropPeer(peer: DeviceRef): void {
    const all = readList(this.ctx, ASKS_KEY);
    if (all.some((r) => same(r, peer))) this.save(all.filter((r) => !same(r, peer)));
  }
}
