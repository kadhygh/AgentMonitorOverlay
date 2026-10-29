import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { REMOTE_FILE_CHUNK, REMOTE_KINDS, REMOTE_LOST_MS, remoteHeldTasks, remoteInUse, remoteProfileId, remoteQuitNote, type ModelProfile, type RemoteState, type SessionItem } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer, type DeviceEvent, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { Backoff } from "./link.js";
import { fitItem } from "./grants.js";
import { amoToolsFor } from "../../mcp/tools.js";

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

  it("says when tasks are used from another device: 完全退出's question and keeping the computer awake", () => {
    const grant = (taskId: string, device = "d_b") => ({ taskId, account: "b", device, name: "旧名字", grantedAt: "" });
    const peer = (online: boolean | null, device = "d_b", name = "B 笔记本") => ({ account: "b", device, name, role: "owner" as const, pairedAt: "", online, lastSeen: null });
    const conn = (state: "online" | "offline") => ({ state, message: null, retryAt: null, since: null });
    expect(remoteInUse(null)).toEqual([]);
    expect(remoteInUse({ grants: [grant("t1"), grant("t2")], peers: [peer(true)], connection: conn("online") })).toEqual([{ name: "B 笔记本", tasks: 2 }]);
    // Away, or this computer not connected: nobody uses it now.
    expect(remoteInUse({ grants: [grant("t1")], peers: [peer(false)], connection: conn("online") })).toEqual([]);
    expect(remoteInUse({ grants: [grant("t1")], peers: [peer(true)], connection: conn("offline") })).toEqual([]);
    const two = remoteInUse({ grants: [grant("t1"), grant("t2", "d_c")], peers: [peer(true), peer(true, "d_c", "平板")], connection: conn("online") });
    expect(remoteQuitNote(two)).toBe("有 2 个任务正被 B 笔记本、平板 远程使用，退出后那边会暂停。");
    expect(remoteQuitNote([])).toBeNull();
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

describe("wrapping up step 2", () => {
  it("B's agents neither see nor touch the copies (AMO MCP); archiving a copy tells A, which ends the grant and stops sending", async () => {
    const { a, b, toB } = await paired();
    const { task, session } = await taskOnA(a, "A 的任务");
    a.remote.grant(task.id, toB);
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 第一句"), "B's copy");
    const own = await b.service.tasks.createTask({ title: "B 自己的任务" });
    const tools = amoToolsFor(b.service, null);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await tools.find((t) => t.name === name)!.run(args);
      return { error: !!r.isError, text: r.content[0]!.text };
    };
    const board = await call("board_list", {});
    expect(board.text).toContain("B 自己的任务");
    expect(board.text).not.toContain("A 的任务");
    for (const [name, args] of [
      ["task_get", { taskId: task.id }],
      ["session_tree", { taskId: task.id }],
      ["task_describe", { taskId: task.id, description: "改说明" }],
      ["mailbox_send", { to: session.id, text: "留言" }],
    ] as const) {
      const r = await call(name, args);
      expect(r.error, name).toBe(true);
      expect(r.text, name).toContain("是 A-PC（台式机的我）授权给这台电脑的远程任务");
    }
    expect((await call("task_get", { taskId: own.task.id })).error).toBe(false);
    expect(b.store.getTask(task.id)!.description ?? "").toBe("");

    // Archived on B (the grant still on): B tells A, A's grant ends, nothing more is sent.
    await b.service.tasks.archiveTask(task.id);
    await until(a.state, (s) => s.grants.length === 0, "A's grant ends");
    expect(a.store.getTask(task.id)!.archivedAt).toBeNull();
  }, 60_000);
});

describe("requests for tasks between two Hosts (step 4)", () => {
  it("B asks, A allows on an allowed model: the task is made, granted and running on B's board; A refuses another, saying why; B takes a third back", async () => {
    const { a, b } = await paired();
    const A = toA(a);
    // Allowing needs 远端允许的模型 chosen first.
    await b.remote.sendAsk(A, "先没选模型", "跑一下");
    const first = await until(a.state, (s) => s.taskRequests.length === 1, "A has the request");
    expect(first.taskRequests[0]).toMatchObject({ title: "先没选模型", text: "跑一下", name: "B-PC", state: "pending" });
    await expect(a.remote.acceptRequest(first.taskRequests[0]!.id, { workspaceId: a.service.commonWorkspace().id, profileId: "p" })).rejects.toThrow("还没有选远端允许的模型");
    a.remote.setAllowed({ profiles: ["p"], defaultProfile: "p", permission: "read-only" });
    await expect(a.remote.acceptRequest(first.taskRequests[0]!.id, { workspaceId: a.service.commonWorkspace().id, profileId: "q" })).rejects.toThrow("不在远端允许的模型里");
    // B sees it waiting.
    expect(b.state().asks).toMatchObject([{ title: "先没选模型", name: "A-PC", state: "pending" }]);

    // Allowed: a task with the request as its 说明, granted to B, its session started with the request.
    const proj = tempDir("asked-proj");
    const ws = a.service.projects.addWorkspace({ path: proj });
    await a.remote.acceptRequest(first.taskRequests[0]!.id, { workspaceId: ws.id, profileId: "p" });
    expect(a.state().taskRequests).toEqual([]);
    const accepted = await until(b.state, (s) => s.asks[0]?.state === "accepted", "B hears it was allowed");
    const taskId = accepted.asks[0]!.taskId!;
    expect(a.store.getTask(taskId)).toMatchObject({ title: "先没选模型", description: "跑一下", workspaceId: ws.id, column: "doing" });
    expect(a.state().grants).toMatchObject([{ taskId, account: "笔记本的我" }]);
    const session = (await until(() => a.store.listSessions({ taskId })[0], Boolean, "A's session"))!;
    expect(session).toMatchObject({ profileId: "p", options: { permission: "read-only" } });
    await until(() => b.store.getTask(taskId)?.remote?.state, (s) => s === "active", "B's copy");
    await until(() => agentTexts(b, session.id), (t) => t.includes("FAKE: 跑一下"), "B sees it run");

    // Refused, saying why.
    await b.remote.sendAsk(A, "第二个", "这个不行吧");
    const second = (await until(a.state, (s) => s.taskRequests.length === 1, "second request")).taskRequests[0]!;
    a.remote.refuseRequest(second.id, "今天不跑这个");
    await until(b.state, (s) => s.asks.some((r) => r.id === second.id && r.state === "refused" && r.reason === "今天不跑这个"), "B hears why");
    await expect(async () => a.remote.refuseRequest(second.id, "again")).rejects.toThrow("已经拒绝了");
    // Put away on B: gone from its list (and from A's).
    await b.remote.withdrawAsk(second.id);
    expect(b.state().asks.some((r) => r.id === second.id)).toBe(false);

    // Taken back while waiting: A no longer has it.
    await b.remote.sendAsk(A, "第三个", "算了");
    const third = (await until(a.state, (s) => s.taskRequests.length === 1, "third request")).taskRequests[0]!;
    await b.remote.withdrawAsk(third.id);
    expect(a.state().taskRequests).toEqual([]);
    await expect(a.remote.acceptRequest(third.id, { workspaceId: ws.id, profileId: "p" })).rejects.toThrow("没有这个请求");

    // A away: B's request does not go (the server keeps none), and says why.
    a.remote.stop();
    await until(b.state, (s) => s.peers[0]?.online === false, "B sees A gone");
    await expect(b.remote.sendAsk(A, "A 不在", "发不出去")).rejects.toThrow("A-PC 不在线，请求没发出去");
    expect(b.state().asks.some((r) => r.title === "A 不在")).toBe(false);
    // Only to a device that allowed this computer; empty texts are refused.
    await expect(a.remote.sendAsk({ account: "笔记本的我", device: b.state().device!.id }, "反过来", "不行")).rejects.toThrow();
  }, 90_000);

  it("A answers while B is away: B learns it when it is back; unpairing drops the requests", async () => {
    const { a, b, toB } = await paired();
    a.remote.setAllowed({ profiles: ["p"], defaultProfile: null, permission: null });
    await b.remote.sendAsk(toA(a), "B 走开时回答", "第一句");
    const r = (await until(a.state, (s) => s.taskRequests.length === 1, "request")).taskRequests[0]!;
    b.remote.stop();
    await until(a.state, (s) => s.peers[0]?.online === false, "A sees B gone");
    a.remote.refuseRequest(r.id, "等你回来再说");
    b.restart();
    await until(b.state, (s) => s.asks.some((x) => x.id === r.id && x.state === "refused" && x.reason === "等你回来再说"), "B catches up on the answer");
    await b.remote.sendAsk(toA(a), "还没回答", "等着");
    await until(a.state, (s) => s.taskRequests.length === 1, "pending");
    await a.remote.unpair(toB);
    expect(a.state().taskRequests).toEqual([]);
    await until(b.state, (s) => s.asks.length === 0, "B's requests to A gone with the pairing");
  }, 60_000);
});

describe("remote files between two Hosts (step 3)", () => {
  it("B fetches a granted task's files from A, keeps them by task, asks again with what it has, and throws them away with the copy", async () => {
    const { a, b, toB } = await paired();
    const proj = tempDir("proj");
    mkdirSync(join(proj, "docs", "img"), { recursive: true });
    writeFileSync(join(proj, "docs", "a.md"), "# 说明\n\n见 ![图](img/p.png)");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(REMOTE_FILE_CHUNK * 2 + 10, 3)]);
    writeFileSync(join(proj, "docs", "img", "p.png"), png);
    writeFileSync(join(proj, "run.exe"), "MZ");
    const ws = a.service.projects.addWorkspace({ path: proj });
    const { task, session } = await a.service.tasks.createTask({ title: "带文件的任务", workspaceId: ws.id, firstSession: { profileId: "p", text: "看 docs/a.md" } });
    await until(() => agentTexts(a, session!.id), (t) => t.length > 0, "A's reply");
    a.remote.grant(task.id, toB);
    await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "active", "B's copy");

    // A's absolute path, as the conversation shows it: B gets it named by its place in the task's folder.
    const progress: Array<[number, number]> = [];
    b.service.on("event", (e) => e.type === "remote.file" && e.fetchId === "f1" && progress.push([e.received, e.total]));
    const md = await b.remote.fetchFile(task.id, join(proj, "docs", "a.md"), undefined, "f1");
    expect(md).toMatchObject({ rel: "docs/a.md", kind: "markdown", device: "A-PC", cached: false });
    expect(readFileSync(md.path, "utf8")).toContain("# 说明");
    expect(md.path.startsWith(join(b.store.path, "..", "remote-files", task.id))).toBe(true);
    expect(progress.at(-1)).toEqual([md.size, md.size]);
    // Asked again, unchanged on A: nothing comes over; changed: the new one does.
    expect(await b.remote.fetchFile(task.id, join(proj, "docs", "a.md"))).toMatchObject({ cached: true, path: md.path });
    writeFileSync(join(proj, "docs", "a.md"), "# 改过了");
    const changed = await b.remote.fetchFile(task.id, join(proj, "docs", "a.md"));
    expect(changed.cached).toBe(false);
    expect(readFileSync(changed.path, "utf8")).toBe("# 改过了");
    // A big picture comes in pieces, through the page's own address (the key) too.
    const img = await b.remote.fetchFile(task.id, "docs/img/p.png", undefined, "f2");
    expect(readFileSync(img.path).equals(png)).toBe(true);
    const served = await b.remote.serveFile(img.key, "docs/img/p.png");
    expect(served).toMatchObject({ path: img.path, mime: "image/png" });
    await expect(b.remote.serveFile("nokeynokeynokey", "docs/img/p.png")).rejects.toThrow();
    await expect(b.remote.serveFile(img.key, "docs/a.md")).rejects.toThrow("only images");
    // Refused on A, said on B.
    await expect(b.remote.fetchFile(task.id, "run.exe")).rejects.toThrow("不能看程序和二进制文件");
    await expect(b.remote.fetchFile(task.id, join(proj, "..", "elsewhere.md"))).rejects.toThrow();
    // An ordinary task of B's own is not fetched from anywhere.
    const own = await b.service.tasks.createTask({ title: "B 自己的" });
    await expect(b.remote.fetchFile(own.task.id, "a.md")).rejects.toThrow("这不是远程任务");

    // A away: the copy from last time, saying so; a file never fetched cannot be had.
    a.remote.stop();
    await until(b.state, (s) => s.peers[0]?.online === false, "B sees A gone");
    const stale = await b.remote.fetchFile(task.id, join(proj, "docs", "a.md"));
    expect(stale).toMatchObject({ cached: true, stale: "A-PC 现在连不上，显示的是上次取来的版本" });
    await expect(b.remote.fetchFile(task.id, "docs/other.md")).rejects.toThrow("A-PC 离线，取不到文件");

    // Archived on B: the copy goes, its files too.
    await b.service.tasks.archiveTask(task.id);
    expect(existsSync(join(b.store.path, "..", "remote-files", task.id))).toBe(false);
  }, 60_000);

  it("archived while a file is on its way: the folder goes at once and the file is not written back", async () => {
    const { a, b, toB } = await paired();
    const proj = tempDir("proj");
    writeFileSync(join(proj, "a.md"), "# 一");
    writeFileSync(join(proj, "big.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(REMOTE_FILE_CHUNK * 3, 5)]));
    const ws = a.service.projects.addWorkspace({ path: proj });
    const { task } = await a.service.tasks.createTask({ title: "取到一半归档", workspaceId: ws.id });
    a.remote.grant(task.id, toB);
    await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "active", "B's copy");
    await b.remote.fetchFile(task.id, "a.md");
    const root = join(b.store.path, "..", "remote-files");
    const coming = b.remote.fetchFile(task.id, "big.png");
    await b.service.tasks.archiveTask(task.id);
    expect(existsSync(join(root, task.id))).toBe(false);
    await expect(coming).rejects.toThrow("已经归档");
    expect(existsSync(join(root, task.id))).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith(".gone-"))).toEqual([]);
  }, 60_000);
});
