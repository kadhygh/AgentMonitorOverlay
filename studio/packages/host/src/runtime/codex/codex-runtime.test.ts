import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session, SessionItem, Workspace } from "@amo-studio/protocol";
import { startFakeAppServer, type FakeAppServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { CodexRuntime, type CodexServers } from "./codex-runtime.js";
import { CodexRpcClient } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-default", label: "Default", runtime: "codex", provider: null, model: null },
];

/** One fake app-server per profile, with the profile's provider as server default (as the real manager does). */
class FakeServers extends EventEmitter<{ ready: [CodexServerHandle] }> implements CodexServers {
  fakes = new Map<string, FakeAppServer>();
  handles = new Map<string, CodexServerHandle>();

  async ensure(profileId: string): Promise<CodexServerHandle> {
    const known = this.handles.get(profileId);
    if (known?.client.isOpen) return known;
    let fake = this.fakes.get(profileId);
    if (!fake) {
      const profile = PROFILES.find((p) => p.id === profileId)!;
      fake = await startFakeAppServer({ defaultProvider: profile.provider ?? "openai" });
      this.fakes.set(profileId, fake);
    }
    const client = await CodexRpcClient.connect({ url: fake.url, token: fake.token });
    const handle: CodexServerHandle = { profileId, url: fake.url, port: fake.port, token: fake.token, client };
    this.handles.set(profileId, handle);
    this.emit("ready", handle);
    return handle;
  }

  async close() {
    for (const h of this.handles.values()) h.client.close();
    for (const f of this.fakes.values()) await f.close();
  }
}

let store: Store;
let servers: FakeServers;
let runtime: CodexRuntime;
let events: HostEvent[];
let workspace: Workspace;
let taskId: string;

beforeEach(() => {
  store = new Store(":memory:");
  servers = new FakeServers();
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  events = [];
  runtime.on("event", (e) => events.push(e));
  workspace = store.addWorkspace({ path: "C:/sandbox/ws", name: "ws" });
  taskId = store.createTask({ title: "t", scope: { kind: "workspace", workspaceId: workspace.id } }).id;
});

afterEach(async () => {
  await servers.close();
  store.close();
});

const until = async (pred: () => boolean, label = "condition", timeoutMs = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const items = (sessionId: string) => store.listItems(sessionId);
const session = (id: string) => store.getSession(id)!;
const lastAgent = (sessionId: string) => items(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent").at(-1);
const idle = (id: string) => () => session(id).status === "idle" && !items(id).some((i) => i.type === "agent" && i.streaming);

describe("CodexRuntime", () => {
  it("starts a session, streams the reply and settles to idle", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "hello" });
    expect(s.runtimeRef).toBeTruthy();
    expect(s.title).toBe("hello");
    await until(idle(s.id), "idle");
    expect(items(s.id).map((i) => i.type)).toEqual(["user", "agent"]);
    expect(lastAgent(s.id)).toMatchObject({ markdown: "FAKE: hello", streaming: false });
    const types = new Set(events.map((e) => e.type));
    expect([...types]).toEqual(expect.arrayContaining(["session.upserted", "item.appended", "item.delta", "item.updated"]));
    const fake = servers.fakes.get("p-ds")!;
    expect(fake.threads.get(s.runtimeRef!)!.modelProvider).toBe("amo-ds");
  });

  it("routes approvals to the person and records the decision", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "[[shell: cmd /c echo x]]" });
    await until(() => session(s.id).status === "awaiting-approval", "awaiting-approval");
    const approval = items(s.id).find((i) => i.type === "approval")!;
    expect(approval).toMatchObject({ kind: "command", summary: "cmd /c echo x", state: "pending" });
    await runtime.respondApproval(s.id, (approval as Extract<SessionItem, { type: "approval" }>).approvalId, "accept");
    await until(idle(s.id), "idle");
    expect(store.getItem(approval.id)).toMatchObject({ state: "accepted" });
    expect(items(s.id).find((i) => i.type === "tool")).toMatchObject({ name: "shell", status: "completed" });
    expect(lastAgent(s.id)!.markdown).toBe("FAKE-RAN");
    await expect(runtime.respondApproval(s.id, "0", "decline")).rejects.toThrow(/not pending/);
  });

  it("marks an approval answered by another client (e.g. the attached TUI) as resolved elsewhere", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "seed" });
    await until(idle(s.id), "seed");
    const fake = servers.fakes.get("p-ds")!;
    const tui = await CodexRpcClient.connect({ url: fake.url, token: fake.token });
    tui.on("request", (r) => tui.respond(r.id, { decision: "decline" }));
    await tui.request("thread/resume", { threadId: s.runtimeRef! } as never);
    await runtime.sendMessage(s.id, "[[shell: cmd /c echo y]]");
    await until(idle(s.id), "idle");
    const approval = items(s.id).find((i) => i.type === "approval")!;
    expect(store.getItem(approval.id)).toMatchObject({ state: "resolved-elsewhere" });
    expect(lastAgent(s.id)!.markdown).toBe("FAKE-DENIED");
    tui.close();
  });

  it("forks with an explicit provider and records the parent once", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "seed" });
    await until(idle(s.id), "seed");
    const fork = await runtime.fork(s.id);
    expect(fork).toMatchObject({ kind: "fork", parentId: s.id, profileId: "p-ds" });
    expect(store.listSessions({ taskId }).filter((x) => x.kind === "fork")).toHaveLength(1);
    expect(servers.fakes.get("p-ds")!.threads.get(fork.runtimeRef!)!.modelProvider).toBe("amo-ds");
    expect(items(fork.id).some((i) => i.type === "notice")).toBe(false);
  });

  it("adopts a fork made by another client and warns when its provider drifted", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "seed" });
    await until(idle(s.id), "seed");
    const fake = servers.fakes.get("p-ds")!;
    const other = await CodexRpcClient.connect({ url: fake.url, token: fake.token });
    // A TUI /fork sends no provider; force a different one to simulate the drift seen with a mismatched server default.
    const r = await other.request("thread/fork", { threadId: s.runtimeRef!, modelProvider: "openai" } as never);
    await until(() => !!store.findSessionByRuntimeRef("codex", r.thread.id), "fork adopted");
    const child = store.findSessionByRuntimeRef("codex", r.thread.id)!;
    expect(child).toMatchObject({ kind: "fork", parentId: s.id });
    expect(items(child.id).find((i) => i.type === "notice")).toMatchObject({ level: "warning" });
    other.close();
  });

  it("records subagents as child sessions with a summary item in the parent", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "[[subagent]]" });
    await until(idle(s.id), "idle");
    const sub = store.listSessions({ taskId }).find((x) => x.kind === "sub")!;
    expect(sub.parentId).toBe(s.id);
    await until(() => session(sub.id).status === "completed", "sub completed");
    expect(items(s.id).find((i) => i.type === "subagent")).toMatchObject({ childSessionId: sub.id });
    expect(lastAgent(sub.id)!.markdown).toBe("FAKE-SUB-DONE");
  });

  it("steers a running turn and interrupts it", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "[[slow]]" });
    await until(() => events.some((e) => e.type === "item.delta"), "streaming");
    expect(await runtime.sendMessage(s.id, "also this")).toEqual({ mode: "steer" });
    await until(idle(s.id), "idle", 8000);
    expect(items(s.id).filter((i) => i.type === "user").map((i) => (i as { text: string }).text)).toEqual(["[[slow]]", "also this"]);

    await runtime.sendMessage(s.id, "[[slow]]");
    await until(() => session(s.id).status === "running", "running");
    await runtime.interrupt(s.id);
    await until(() => session(s.id).status === "idle", "idle after interrupt");
  });

  it("archives with descendants, blocks writes, and restores", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "seed" });
    await until(idle(s.id), "seed");
    const fork = await runtime.fork(s.id);
    const archived = await runtime.archive(s.id);
    expect(archived.map((x: Session) => x.id).sort()).toEqual([s.id, fork.id].sort());
    expect(servers.fakes.get("p-ds")!.threads.get(s.runtimeRef!)!.archived).toBe(true);
    await expect(runtime.sendMessage(s.id, "x")).rejects.toThrow(/read-only/);
    await runtime.unarchive(s.id);
    expect(session(fork.id).writer).toBe("workbench");
    expect(servers.fakes.get("p-ds")!.threads.get(s.runtimeRef!)!.archived).toBe(false);
  });

  it("resubscribes live threads after the server connection comes back", async () => {
    const s = await runtime.startSession({ taskId, profileId: "p-ds", workspace, text: "seed" });
    await until(idle(s.id), "seed");
    const fake = servers.fakes.get("p-ds")!;
    servers.handles.get("p-ds")!.client.close();
    const before = fake.calls.filter((c) => c.method === "thread/resume").length;
    await servers.ensure("p-ds");
    await until(() => fake.calls.filter((c) => c.method === "thread/resume").length > before, "resume after reconnect");
    await runtime.sendMessage(s.id, "after reconnect");
    await until(() => lastAgent(s.id)?.markdown === "FAKE: after reconnect", "reply after reconnect");
  });
});
