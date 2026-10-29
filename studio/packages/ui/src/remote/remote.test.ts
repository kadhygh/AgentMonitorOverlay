import { describe, expect, it } from "vitest";
import { REMOTE_LOST_MS, type RemotePeer, type RemoteState, type Task } from "@amo-studio/protocol";
import { copyStatus, grantsOf, remoteButton, remoteWaiting } from "./remote.js";

// 远程 step 2 (2026-10-29): how a copy of a remote task stands on B — usable, its computer away (or this one not
// connected), or revoked — and what the composer says while nothing can be sent.

const now = Date.parse("2026-10-29T10:00:00Z");
const task = (state: "active" | "revoked" = "active", reason?: string): Task => ({
  id: "task_1",
  title: "远程任务",
  workspaceId: "ws",
  topicId: null,
  column: "doing",
  remote: { account: "台式机的我", device: "d_a", name: "A 台式机", state, ...(reason ? { reason } : {}), profiles: [], allowed: [], grantedAt: "" },
  createdAt: "",
  updatedAt: "",
  archivedAt: null,
});
const peer = (online: boolean | null, lastSeen: string | null = null): RemotePeer => ({ account: "台式机的我", device: "d_a", name: "A 台式机", role: "guest", pairedAt: "", online, lastSeen });
const state = (peers: RemotePeer[], connected = true): RemoteState => ({
  device: { id: "d_b", name: "B" },
  account: { server: "http://x", name: "笔记本的我" },
  connection: { state: connected ? "online" : "offline", message: null, retryAt: null, since: null },
  peers,
  incoming: [],
  outgoing: [],
  grants: [{ taskId: "task_9", account: "x", device: "d_x", name: "X", grantedAt: "" }],
  allowed: { profiles: [], defaultProfile: null, permission: null },
  taskRequests: [],
  asks: [],
});

describe("remoteWaiting (the dot on the top bar's 远程)", () => {
  const req = (state: "pending" | "accepted" | "refused") => ({ id: `rq_${state}`, title: "t", text: "x", account: "a", device: "d", name: "A", state, createdAt: "" });
  it("counts pairing requests, requests for tasks to answer here, and refusals not put away", () => {
    expect(remoteWaiting(null)).toBe(0);
    expect(remoteWaiting(state([]))).toBe(0);
    expect(remoteWaiting({ ...state([]), taskRequests: [req("pending")], asks: [req("pending"), req("accepted"), req("refused")] })).toBe(2);
  });
});

describe("remoteButton (the top bar's 远程)", () => {
  it("is hidden without remote, plain when nothing is paired or nobody is logged in, and counts online devices once each", () => {
    expect(remoteButton(null, now).shown).toBe(false);
    expect(remoteButton({ ...state([]), connection: { state: "off", message: null, retryAt: null, since: null } }, now).shown).toBe(false);
    expect(remoteButton(state([]), now)).toEqual({ shown: true, label: "远程", waiting: false });
    expect(remoteButton({ ...state([]), account: null, connection: { state: "no-account", message: null, retryAt: null, since: null } }, now)).toEqual({ shown: true, label: "远程", waiting: false });
    // Paired both ways with one device (two entries), another device away.
    const other: RemotePeer = { ...peer(false), device: "d_c", name: "C" };
    expect(remoteButton(state([peer(true), { ...peer(true), role: "owner" }, other]), now).label).toBe("远程 · 1 在线");
    expect(remoteButton(state([other]), now).label).toBe("远程 · 0 在线");
    expect(remoteButton({ ...state([]), incoming: [{ id: "pr_1", account: "a", device: "d", name: "A", createdAt: "", expiresAt: "" }] }, now).waiting).toBe(true);
  });
});

describe("copyStatus", () => {
  it("is nothing for a task of this computer's own", () => {
    expect(copyStatus({ ...task(), remote: undefined } as Task, state([peer(true)]), now)).toBeNull();
  });

  it("can send while A is online; greys with why when A is away (刚失联 too) or this computer is not connected", () => {
    expect(copyStatus(task(), state([peer(true)]), now)).toMatchObject({ state: "online", label: "远程 · A 台式机", blocked: null });
    expect(copyStatus(task(), state([peer(false, new Date(now - 60_000).toISOString())]), now)).toMatchObject({ state: "offline", label: "A 台式机 离线", blocked: "A 台式机 离线，回来后再发" });
    expect(copyStatus(task(), state([peer(false, new Date(now - REMOTE_LOST_MS - 1).toISOString())]), now)).toMatchObject({ state: "offline" });
    expect(copyStatus(task(), state([peer(null)], false), now)).toMatchObject({ state: "offline", label: "没连上服务器", blocked: "这台电脑没连上团队服务器，回来后再发", self: true });
    // No pair any more (the pairing ended before the copy heard): away.
    expect(copyStatus(task(), state([]), now)).toMatchObject({ state: "offline" });
    // Still reading the state: shown as usable, a send says what is wrong.
    expect(copyStatus(task(), null, now)).toMatchObject({ state: "unknown", blocked: null });
  });

  it("is revoked, saying why when it was not A taking it back", () => {
    expect(copyStatus(task("revoked", "授权已收回"), state([peer(true)]), now)).toMatchObject({ state: "revoked", label: "授权已收回", blocked: "授权已收回：记录还能看，不能再发消息" });
    expect(copyStatus(task("revoked", "配对已解除"), null, now)!.blocked).toBe("授权已收回（配对已解除）：记录还能看，不能再发消息");
  });

  it("lists the grants of a task on A", () => {
    expect(grantsOf(state([]), "task_9").map((g) => g.name)).toEqual(["X"]);
    expect(grantsOf(state([]), "task_1")).toEqual([]);
    expect(grantsOf(null, "task_9")).toEqual([]);
  });
});
