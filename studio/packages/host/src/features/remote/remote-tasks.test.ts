import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { REMOTE_KINDS, REMOTE_LOST_MS, remoteHeldTasks, remoteProfileId, type ModelProfile, type RemoteState, type SessionItem } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer, type DeviceEvent, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { Backoff } from "./link.js";
import { fitItem } from "./grants.js";

// 远程, step 2 (plans/remote-session.md, 2026-10-29): A grants a task to a paired B; B's copy follows A, B's messages,
// approvals, 打断 and new sessions run on A, a revoked grant stays readable on B, and catch-up goes by seq. Two Hosts
// through a relay service on this machine (never the team server), the fake Codex app-server as the model.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [
  { id: "p", label: "P", runtime: "codex", provider: "x", model: "m" },
  { id: "q", label: "Q", runtime: "codex", provider: "y", model: "n" },
];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-rtask-${name}-`));
  cleanups.push(() => removeTempDir(d));
  return d;
};

async function until<T>(read: () => T, ok: (v: T) => boolean, what = "condition", ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let relayStore: RelayStore;
let relay: RelayServer;

async function relayService(): Promise<{ url: string; keys: Record<string, string> }> {
  relayStore = new RelayStore(":memory:");
  relay = await startRelayServer({ store: relayStore, host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const keys = { 台式机的我: relayStore.register("台式机的我", "pw-aaaa").key, 笔记本的我: relayStore.register("笔记本的我", "pw-bbbb").key };
  return { url: relay.url, keys };
}

async function host(name: string, server: string, account: string, key: string) {
  const home = tempDir(name);
  const env = { AMO_HOME: home, COMPUTERNAME: name };
  await saveAccount({ server, name: account, key }, { env, protector: fake });
  const store = new Store(join(tempDir(`${name}-data`), "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  const options = { env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }), pingTimeoutMs: 2000 };
  service.remote.start(options);
  cleanups.push(async () => {
    service.remote.stop();
    await servers.close();
    store.close();
  });
  const state = () => service.remote.state();
  return { service, store, env, state, remote: service.remote, restart: () => service.remote.start(options) };
}

const online = (s: RemoteState) => s.connection.state === "online";

/** A (台式机的我) and B (笔记本的我), paired: A allowed B. */
async function paired() {
  const { url, keys } = await relayService();
  const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]!);
  const b = await host("B-PC", url, "笔记本的我", keys["笔记本的我"]!);
  await until(a.state, online, "A online");
  await until(b.state, online, "B online");
  await b.remote.requestPair("台式机的我");
  const req = (await until(a.state, (s) => s.incoming.length === 1, "request")).incoming[0]!;
  await a.remote.answer(req.id, true);
  await until(b.state, (s) => s.peers.length === 1 && s.peers[0]!.online === true, "B sees A");
  const toB = { account: "笔记本的我", device: b.state().device!.id };
  const aDevice = a.state().device!.id;
  return { url, keys, a, b, toB, aDevice };
}

type Pair = Awaited<ReturnType<typeof paired>>;
const items = (h: Pair["a"], sessionId: string) => h.store.listItems(sessionId);
const agentTexts = (h: Pair["a"], sessionId: string) => items(h, sessionId).flatMap((i) => (i.type === "agent" && !i.streaming ? [i.markdown] : []));

/** A task on A with one session that has answered once. */
async function taskOnA(a: Pair["a"], title = "远程任务") {
  const { task, session } = await a.service.tasks.createTask({ title, firstSession: { profileId: "p", text: "第一句" } });
  await until(() => agentTexts(a, session!.id), (t) => t.includes("FAKE: 第一句"), "A's first reply");
  await until(() => a.store.getSession(session!.id)!.status, (s) => s === "idle" || s === "completed", "A idle");
  return { task, session: session! };
}

describe("remote tasks between two Hosts (step 2)", () => {
  it("A grants a task: B's copy follows, B's messages, approvals (first come) and new sessions run on A; revoked, it stays readable", async () => {
    const { a, b, toB, aDevice } = await paired();
    const { task, session } = await taskOnA(a);

    a.remote.grant(task.id, toB);
    expect(a.state().grants).toMatchObject([{ taskId: task.id, account: "笔记本的我", name: "B-PC" }]);
    // B: a copy under A's ids, in its common space, its sessions running "remote" on A's models.
    const copy = await until(() => b.store.getTask(task.id), (t) => t?.remote?.state === "active", "B's copy");
    expect(copy!.title).toBe("远程任务");
    expect(copy!.remote).toMatchObject({ account: "台式机的我", device: aDevice, name: "A-PC", allowed: [remoteProfileId(aDevice, "p")] });
    expect(copy!.workspaceId).toBe(b.service.commonWorkspace().id);
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 第一句"), "B has A's items");
    expect(b.store.getSession(session.id)).toMatchObject({ runtime: "remote", profileId: remoteProfileId(aDevice, "p"), taskId: task.id });
    expect(items(b, session.id).map((i) => [i.id, i.seq])).toEqual(items(a, session.id).map((i) => [i.id, i.seq]));
    // The model's name, for B's windows: a hidden profile.
    expect(b.service.snapshot().profiles.find((p) => p.id === remoteProfileId(aDevice, "p"))).toMatchObject({ label: "Codex · P", runtime: "remote", hidden: true });

    // A message from B runs on A, and its reply comes back to B.
    await b.service.sessions.sendMessage(session.id, "从 B 发的");
    await until(() => agentTexts(a, session.id), (t) => t.includes("FAKE: 从 B 发的"), "A replies");
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 从 B 发的"), "B sees the reply");
    await until(() => b.store.getSession(session.id)!.status, (s) => s === "idle" || s === "completed", "B's copy idle");

    // An approval: B answers it first; A's card follows; a second answer is refused, saying why.
    await b.service.sessions.sendMessage(session.id, "[[shell: cmd /c echo remote]]");
    const pending = (await until(() => items(b, session.id).find((i) => i.type === "approval" && i.state === "pending"), Boolean, "B has the approval")) as Extract<SessionItem, { type: "approval" }>;
    expect(b.store.getSession(session.id)!.status).toBe("awaiting-approval");
    await b.service.sessions.respondApproval(session.id, pending.approvalId, "accept");
    await until(() => a.store.getItem(pending.id), (i) => (i as { state?: string })?.state === "accepted", "A's approval accepted");
    await until(() => b.store.getItem(pending.id), (i) => (i as { state?: string })?.state === "accepted", "B's approval accepted");
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE-RAN"), "B sees the command ran");
    await expect(b.service.sessions.respondApproval(session.id, pending.approvalId, "decline")).rejects.toThrow(/已经处理过|not pending/);

    // A new session from B: only on a model A allows (by default those the task already uses).
    await expect(b.service.tasks.addSession(task.id, { profileId: remoteProfileId(aDevice, "q") })).rejects.toThrow("不在 A-PC 允许远程使用的模型里");
    await expect(b.service.tasks.addSession(task.id, { profileId: "p" })).rejects.toThrow("不在 A-PC 允许远程使用的模型里");
    const second = await b.service.tasks.addSession(task.id, { profileId: remoteProfileId(aDevice, "p"), text: "B 开的会话" });
    expect(a.store.getSession(second.id)).toMatchObject({ taskId: task.id, profileId: "p", runtime: "codex" });
    await until(() => agentTexts(b, second.id), (t) => t.includes("FAKE: B 开的会话"), "B sees its new session's reply");
    // A allows Q too: B's copy hears it.
    a.remote.setAllowed({ profiles: ["p", "q"], defaultProfile: "q", permission: "read-only" });
    await until(() => b.store.getTask(task.id)!.remote!.allowed, (l) => l.join() === [remoteProfileId(aDevice, "q"), remoteProfileId(aDevice, "p")].join(), "B gets the new allowed list");
    const third = await b.service.tasks.addSession(task.id, { profileId: remoteProfileId(aDevice, "q") });
    expect(a.store.getSession(third.id)).toMatchObject({ profileId: "q", options: { permission: "read-only" } });

    // What only A does is refused on B (its Host and its runtime both).
    await expect(async () => b.service.tasks.updateTask(task.id, { title: "改名" })).rejects.toThrow("远程任务");
    expect(() => b.remote.guardRoute("PATCH", "/api/tasks/:id", { id: task.id })).toThrow("A-PC 上的远程任务");
    expect(() => b.remote.guardRoute("POST", "/api/sessions/:id/fork", { id: session.id })).toThrow("A-PC 上的远程任务");
    expect(() => b.remote.guardRoute("POST", "/api/sessions/:id/messages", { id: session.id })).not.toThrow();
    await expect(b.service.sessions.fork(session.id)).rejects.toThrow("远程任务的会话不能在这台电脑上分支");
    // A's own tasks are never B's to reach.
    const other = await a.service.tasks.createTask({ title: "没授权的" });
    await expect(b.service.tasks.addSession(other.task.id, { profileId: remoteProfileId(aDevice, "p") })).rejects.toThrow();

    // Revoked: B keeps what it has, readable, and reaches the task no more.
    a.remote.revoke(task.id, toB);
    const revoked = await until(() => b.store.getTask(task.id), (t) => t?.remote?.state === "revoked", "B's copy revoked");
    expect(revoked!.remote!.reason).toBe("授权已收回");
    expect(agentTexts(b, session.id)).toContain("FAKE: 从 B 发的");
    await expect(b.service.sessions.sendMessage(session.id, "还能发吗")).rejects.toThrow("授权已收回");
    // Archived on B: the copy is gone from B; A keeps the task.
    await b.service.tasks.archiveTask(task.id);
    expect(b.store.getTask(task.id)).toBeUndefined();
    expect(b.store.getSession(session.id)).toBeUndefined();
    expect(a.store.getTask(task.id)!.archivedAt).toBeNull();
  }, 60_000);

  it("B away: back, it catches up by seq and re-checks approvals; a grant taken back meanwhile is revoked; an archived copy does not come back", async () => {
    const { a, b, toB } = await paired();
    const { task, session } = await taskOnA(a);
    a.remote.grant(task.id, toB);
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 第一句"), "B has the first reply");

    // B goes away; A goes on, and an approval waits.
    b.remote.stop();
    await until(a.state, (s) => s.peers[0]?.online === false, "A sees B gone");
    expect(remoteHeldTasks(a.state(), Date.now()).has(task.id)).toBe(true);
    expect(remoteHeldTasks(a.state(), Date.now() + REMOTE_LOST_MS + 1000).has(task.id)).toBe(false);
    await a.service.sessions.sendMessage(session.id, "B 不在的时候");
    await until(() => agentTexts(a, session.id), (t) => t.includes("FAKE: B 不在的时候"), "A replies");
    await a.service.sessions.sendMessage(session.id, "[[shell: cmd /c echo later]]");
    const approval = (await until(() => items(a, session.id).find((i) => i.type === "approval" && i.state === "pending"), Boolean, "A's approval")) as Extract<SessionItem, { type: "approval" }>;
    b.restart();
    await until(() => items(b, session.id).find((i) => i.id === approval.id), Boolean, "B caught up to the approval");
    expect(agentTexts(b, session.id)).toContain("FAKE: B 不在的时候");
    expect(b.store.getSession(session.id)!.status).toBe("awaiting-approval");
    // A answers it itself; B's card follows (first come on A's side this time).
    await a.service.sessions.respondApproval(session.id, approval.approvalId, "decline");
    await until(() => b.store.getItem(approval.id), (i) => (i as { state?: string })?.state === "declined", "B's card follows A");

    // Taken back while B is away: B finds out when it is back.
    b.remote.stop();
    await until(a.state, (s) => s.peers[0]?.online === false, "A sees B gone again");
    a.remote.revoke(task.id, toB);
    b.restart();
    await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "revoked", "revoked after coming back");

    // Granted again, archived on B while the grant lasts: put away, a sync does not bring it back.
    const second = await taskOnA(a, "第二个");
    a.remote.grant(second.task.id, toB);
    await until(() => b.store.getTask(second.task.id)?.remote?.state, (s) => s === "active", "second copy");
    await b.service.tasks.archiveTask(second.task.id);
    await b.remote.copies.syncPeer(toA(a));
    expect(b.store.getTask(second.task.id)).toBeUndefined();
  }, 60_000);

  it("A away: B cannot send (said why) and catches up once A is back; a question is answered from B", async () => {
    const { a, b, toB } = await paired();
    const { task, session } = await taskOnA(a);
    a.remote.grant(task.id, toB);
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 第一句"), "B's copy");

    // A question from A's session, answered on B; A's reply comes back.
    await b.service.sessions.sendMessage(session.id, "[[ask]]");
    const q = await until(() => items(b, session.id).find((i) => i.type === "question" && i.state === "pending"), Boolean, "B has the question");
    expect(b.store.getSession(session.id)!.status).toBe("awaiting-answer");
    await b.service.sessions.answerQuestion(session.id, q!.id, { action: "answer", answers: [{ id: "target", selected: [], other: "从 B 答的" }, { id: "token", selected: [], other: "x" }] });
    await until(() => agentTexts(b, session.id), (t) => t.some((x) => x.startsWith("FAKE-ANSWERS") && x.includes("从 B 答的")), "B sees A's reply to the answer");
    await until(() => b.store.getItem(q!.id), (i) => (i as { state?: string })?.state === "answered", "B's question answered");

    // A goes away (its Studio quits): B says so and sends nothing.
    a.remote.stop();
    await until(b.state, (s) => s.peers[0]?.online === false, "B sees A gone");
    await expect(b.service.sessions.sendMessage(session.id, "A 不在")).rejects.toThrow("A-PC 离线，回来后再发");
    expect(items(a, session.id).some((i) => i.type === "user" && i.text === "A 不在")).toBe(false);
    // A works on meanwhile, and comes back: B catches up by itself.
    await a.service.sessions.sendMessage(session.id, "A 自己接着做");
    await until(() => agentTexts(a, session.id), (t) => t.includes("FAKE: A 自己接着做"), "A replies");
    a.restart();
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: A 自己接着做"), "B catches up after A is back");
    await b.service.sessions.sendMessage(session.id, "A 回来了");
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: A 回来了"), "B's message goes again");
  }, 60_000);

  it("unpairing on A takes every grant with it; B's copies say the pairing ended", async () => {
    const { a, b, toB } = await paired();
    const { task } = await taskOnA(a);
    a.remote.grant(task.id, toB);
    await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "active", "copy");
    await a.remote.unpair(toB);
    expect(a.state().grants).toEqual([]);
    const t = await until(() => b.store.getTask(task.id), (x) => x?.remote?.state === "revoked", "revoked on B");
    expect(t!.remote!.reason).toBe("配对已解除");
  }, 30_000);

  it("answers a repeated command once, refuses what is not granted, and grants only to devices it allowed", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]!);
    await until(a.state, online, "A online");
    const { task, session } = await taskOnA(a);
    const bDevice = "d_bbbbbbbbbbbbbbbbbbbbbbbb";
    await expect(async () => a.remote.grant(task.id, { account: "笔记本的我", device: bDevice })).rejects.toThrow("只能授权给这台电脑允许配对的设备");
    const req = (await (await fetch(`${url}/api/devices/pair`, { method: "POST", headers: { authorization: `Bearer ${keys["笔记本的我"]}`, "content-type": "application/json" }, body: JSON.stringify({ device: bDevice, deviceName: "B-raw", to: "台式机的我" }) })).json()) as { request: { id: string } };
    await until(a.state, (s) => s.incoming.length === 1, "request");
    await a.remote.answer(req.request.id, true);
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/devices/ws?device=${bDevice}&name=B-raw`, { headers: { authorization: `Bearer ${keys["笔记本的我"]}` } });
    cleanups.push(() => ws.terminate());
    const got: DeviceEvent[] = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as DeviceEvent));
    await new Promise((r) => ws.once("open", r));
    await until(a.state, (s) => s.peers[0]?.online === true, "A sees B online");
    const toA = { account: "台式机的我", device: a.state().device!.id };
    const answers = (re: string) => got.filter((e) => e.type === "relay" && e.re === re);

    // Not granted yet: said so.
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "early-1", kind: REMOTE_KINDS.task, body: { taskId: task.id } }));
    expect((await until(() => answers("early-1"), (l) => l.length === 1, "refusal"))[0]).toMatchObject({ kind: "error", body: { code: "not_found" } });

    a.remote.grant(task.id, { account: "笔记本的我", device: bDevice });
    // The grant is pushed.
    await until(() => got.filter((e) => e.type === "relay" && e.kind === REMOTE_KINDS.push), (l) => l.some((e) => (e as { body: { type: string } }).body.type === "granted"), "granted push");
    // The same message twice under one id: one message on A, the same answer twice.
    const send = { type: "relay", to: toA, id: "same-send", kind: REMOTE_KINDS.send, body: { sessionId: session.id, text: "只发一次" } };
    ws.send(JSON.stringify(send));
    ws.send(JSON.stringify(send));
    const two = await until(() => answers("same-send"), (l) => l.length === 2, "two answers");
    expect(two[0]).toMatchObject({ kind: REMOTE_KINDS.ok });
    expect(two[1]).toEqual(two[0]);
    await until(() => agentTexts(a, session.id), (t) => t.includes("FAKE: 只发一次"), "A replies once");
    expect(items(a, session.id).filter((i) => i.type === "user" && i.text === "只发一次")).toHaveLength(1);
    // Another session of A's, outside the grant.
    const other = await taskOnA(a, "别的任务");
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "other-1", kind: REMOTE_KINDS.items, body: { sessionId: other.session.id, since: 0 } }));
    expect((await until(() => answers("other-1"), (l) => l.length === 1, "refusal"))[0]).toMatchObject({ kind: "error", body: { code: "not_found", message: "这个任务没有授权给你（可能已经收回）" } });
    // Items in pieces, from a seq.
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "items-1", kind: REMOTE_KINDS.items, body: { sessionId: session.id, since: 2 } }));
    const piece = (await until(() => answers("items-1"), (l) => l.length === 1, "items"))[0] as { body: { items: SessionItem[]; more: boolean } };
    expect(piece.body.more).toBe(false);
    expect(piece.body.items[0]!.seq).toBe(3);
    // An answer that comes back late (as if B's wait had ended) is not answered again: no echo between the two.
    const before = got.length;
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "late-1", kind: "pong", re: "gone-1", body: {} }));
    await new Promise((r) => setTimeout(r, 300));
    expect(got.slice(before).filter((e) => e.type === "relay" && e.re === "late-1")).toEqual([]);
  }, 60_000);
});

describe("remote limits on A", () => {
  it("delegated sessions in a granted task stay in its project and on allowed models", async () => {
    const { a, toB } = await paired();
    const { task } = await taskOnA(a);
    expect(a.remote.grants.limitDelegation(task.id, { profileId: "q", elsewhere: false })).toBeNull();
    a.remote.grant(task.id, toB);
    expect(a.remote.grants.limitDelegation(task.id, { profileId: "p", elsewhere: false })).toEqual({ profileId: "p", note: null, permission: undefined });
    expect(a.remote.grants.limitDelegation(task.id, { profileId: "q", elsewhere: false })).toMatchObject({ profileId: "p", note: expect.stringContaining("换成了 Codex · P") });
    expect(() => a.remote.grants.limitDelegation(task.id, { profileId: "p", elsewhere: true })).toThrow("暂时不能把会话开到别的项目");
    expect(() => a.remote.setAllowed({ profiles: ["nope"], defaultProfile: null, permission: null })).toThrow("没有模型 nope");
    expect(() => a.remote.setAllowed({ profiles: ["p"], defaultProfile: "q", permission: null })).toThrow("默认的模型要在允许的里面");
    expect(() => a.remote.setAllowed({ profiles: [], defaultProfile: null, permission: "root" })).toThrow("permission");
    a.remote.setAllowed({ profiles: ["q"], defaultProfile: null, permission: "write" });
    expect(a.remote.grants.limitDelegation(task.id, { profileId: "p", elsewhere: false })).toMatchObject({ profileId: "q", permission: "workspace-write" });
  }, 30_000);

  it("keeps a granted task's reminders off A while the device is online or just gone, not when this computer cannot tell", () => {
    const now = Date.parse("2026-10-29T10:00:00Z");
    const grant = { taskId: "task_1", account: "b", device: "d_b", name: "B", grantedAt: "" };
    const peer = (online: boolean | null, lastSeen: string | null) => ({ account: "b", device: "d_b", name: "B", role: "owner" as const, pairedAt: "", online, lastSeen });
    expect(remoteHeldTasks({ grants: [grant], peers: [peer(true, null)] }, now).has("task_1")).toBe(true);
    expect(remoteHeldTasks({ grants: [grant], peers: [peer(false, new Date(now - 60_000).toISOString())] }, now).has("task_1")).toBe(true);
    expect(remoteHeldTasks({ grants: [grant], peers: [peer(false, new Date(now - REMOTE_LOST_MS - 1).toISOString())] }, now).has("task_1")).toBe(false);
    expect(remoteHeldTasks({ grants: [grant], peers: [peer(null, null)] }, now).has("task_1")).toBe(false);
    expect(remoteHeldTasks(null, now).size).toBe(0);
  });

  it("cuts an item too big for one frame, saying so", () => {
    const big = { id: "i1", sessionId: "s", seq: 1, createdAt: "", type: "agent", markdown: "长".repeat(200_000), streaming: false } as SessionItem;
    const cut = fitItem(big) as Extract<SessionItem, { type: "agent" }>;
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThan(300_000);
    expect(cut.markdown).toContain("远程只传了前面一部分");
    const small = { ...big, markdown: "短" } as SessionItem;
    expect(fitItem(small)).toBe(small);
  });
});

const toA = (a: Pair["a"]) => ({ account: "台式机的我", device: a.state().device!.id });
