import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Workspace } from "@amo-studio/protocol";
import { DEMO_FILE, DEMO_FILE_TEXT, mockCodexProvider, removeTempDir, startMockModel, type MockModelServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { CodexRuntime } from "./codex-runtime.js";
import { CodexServerManager } from "./server-manager.js";

// Integration: Store + CodexServerManager + CodexRuntime against the real `codex app-server` (npm CLI) and the mock
// model. Covers start, approval, fork, archive, server crash and a Host restart. No model budget.

const PROFILES: ModelProfile[] = [
  { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" },
];
const root = mkdtempSync(join(tmpdir(), "amo-studio-test-runtime-"));
const dataDir = join(root, "data");
const dbPath = join(dataDir, "studio.db");
const wsDir = join(root, "workspace");
mkdirSync(join(root, "codex-home"), { recursive: true });
mkdirSync(wsDir, { recursive: true });

let mock: MockModelServer;

interface Host {
  store: Store;
  manager: CodexServerManager;
  runtime: CodexRuntime;
}
const hosts: Host[] = [];

function startHost(): Host {
  const store = new Store(dbPath);
  const manager = new CodexServerManager({
    dataDir,
    profiles: PROFILES,
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    cwd: root,
    env: { CODEX_HOME: join(root, "codex-home"), AMO_STUDIO_MCP_TOKEN: "mcp-token-in-server-env" },
    providers: { "amo-mock": mockCodexProvider(mock.baseUrl) },
    portRange: [47930, 47939],
    backoffMs: { first: 200, max: 1000 },
  });
  const runtime = new CodexRuntime({ store, servers: manager, profiles: PROFILES, approvalPolicy: "untrusted", sandbox: "read-only" });
  const host = { store, manager, runtime };
  hosts.push(host);
  return host;
}

const until = async (pred: () => boolean, label: string, timeoutMs = 30_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  mock = await startMockModel();
});

afterAll(async () => {
  for (const h of hosts) {
    await h.manager.stopAll();
    h.store.close();
  }
  await mock.close();
  removeTempDir(root);
});

describe("Codex runtime against the real app-server", () => {
  let host: Host;
  let workspace: Workspace;
  let taskId: string;
  let mainId: string;

  const items = (id: string) => host.store.listItems(id);
  const lastAgent = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent").at(-1);
  const status = (id: string) => host.store.getSession(id)!.status;
  const settled = (id: string) => () => status(id) === "idle" && !items(id).some((i) => i.type === "agent" && i.streaming);

  it("starts a session and gets the streamed reply", async () => {
    host = startHost();
    workspace = host.store.addWorkspace({ path: wsDir, name: "workspace" });
    taskId = host.store.createTask({ title: "integration", scope: { kind: "workspace", workspaceId: workspace.id } }).id;
    const s = await host.runtime.startSession({ taskId, profileId: "codex-mock", workspace, text: "hello" });
    mainId = s.id;
    // A new session is idle before its first turn starts, so wait for the reply itself.
    await until(() => lastAgent(mainId)?.markdown === "MOCK: hello" && settled(mainId)(), "first reply");
    expect(items(mainId).map((i) => i.type)).toEqual(["turn", "user", "agent"]);
    // The turn item ties the items together and records how the turn went and what it used.
    const turn = items(mainId)[0] as Extract<SessionItem, { type: "turn" }>;
    expect(turn).toMatchObject({ state: "completed", usage: { input: expect.any(Number), output: expect.any(Number) } });
    expect(turn.endedAt).toBeTruthy();
    expect(items(mainId).every((i) => i.raw?.turnId === turn.turnId)).toBe(true);
  }, 60_000);

  it("routes a command approval and records the tool result", async () => {
    await host.runtime.sendMessage(mainId, "[[shell: cmd /c echo studio-approval]]");
    await until(() => status(mainId) === "awaiting-approval", "approval");
    const approval = items(mainId).find((i): i is Extract<SessionItem, { type: "approval" }> => i.type === "approval")!;
    expect(approval.state).toBe("pending");
    await host.runtime.respondApproval(mainId, approval.approvalId, "accept");
    await until(settled(mainId), "after approval");
    const tool = items(mainId).find((i) => i.type === "tool");
    expect(tool).toMatchObject({ name: "shell", status: "completed" });
    expect((tool as { detail?: string }).detail).toContain("studio-approval");
    expect(lastAgent(mainId)!.markdown).toBe("MOCK-DONE");
  }, 60_000);

  it("keeps the provider key and the MCP token out of the agent's commands", async () => {
    const before = items(mainId).filter((i) => i.type === "tool").length;
    // Only the variables in question: a full listing would be cut to its last 4000 characters.
    await host.runtime.sendMessage(mainId, "[[shell: cmd /c echo K=%AMO_MOCK_API_KEY% M=%AMO_STUDIO_MCP_TOKEN% E=%PATHEXT%]]");
    await until(() => status(mainId) === "awaiting-approval", "approval");
    const approval = items(mainId).filter((i): i is Extract<SessionItem, { type: "approval" }> => i.type === "approval").at(-1)!;
    await host.runtime.respondApproval(mainId, approval.approvalId, "accept");
    await until(settled(mainId), "after approval");
    const tool = items(mainId).filter((i) => i.type === "tool")[before] as { detail?: string };
    expect(tool.detail).toMatch(/E=\.COM/i); // the command really ran and expanded variables
    expect(tool.detail).not.toContain("mock-key");
    expect(tool.detail).not.toContain("mcp-token-in-server-env");
  }, 60_000);

  it("shows a working turn: thinking, reading, editing, running a check, answering", async () => {
    writeFileSync(join(wsDir, DEMO_FILE), DEMO_FILE_TEXT);
    const before = items(mainId).length;
    await host.runtime.sendMessage(mainId, "[[demo]] 给导入器加上重试");
    // Approve whatever the turn asks for until it is done.
    const start = Date.now();
    for (;;) {
      if (Date.now() - start > 60_000) throw new Error("demo turn did not finish");
      const pending = items(mainId).find((i): i is Extract<SessionItem, { type: "approval" }> => i.type === "approval" && i.state === "pending");
      if (pending) await host.runtime.respondApproval(mainId, pending.approvalId, "accept");
      const turn = items(mainId).slice(before).find((i) => i.type === "turn");
      if (turn?.type === "turn" && turn.state !== "running" && settled(mainId)()) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const added = items(mainId).slice(before);
    const thinking = added.filter((i): i is Extract<SessionItem, { type: "reasoning" }> => i.type === "reasoning");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking[0]!.text).toContain("importer.py");
    expect(thinking.every((t) => !t.streaming && typeof t.durationMs === "number")).toBe(true);
    const tools = added.filter((i): i is Extract<SessionItem, { type: "tool" }> => i.type === "tool");
    expect(tools.find((t) => t.kind === "read")).toMatchObject({ summary: DEMO_FILE, status: "completed" });
    const edit = tools.find((t) => t.kind === "edit")!;
    expect(edit.files?.[0]).toMatchObject({ path: DEMO_FILE, change: "update" });
    expect(edit.files![0]!.added).toBeGreaterThan(5);
    expect(tools.find((t) => t.kind === "command")).toMatchObject({ exitCode: 0, status: "completed" });
    expect(lastAgent(mainId)!.markdown).toContain("| `retries` | 3 |");
  }, 90_000);

  it("forks on the same provider and keeps context", async () => {
    const fork = await host.runtime.fork(mainId);
    expect(fork).toMatchObject({ kind: "fork", parentId: mainId });
    expect(host.store.listSessions({ taskId }).filter((s) => s.kind === "fork")).toHaveLength(1);
    await host.runtime.sendMessage(fork.id, "in the fork");
    await until(() => lastAgent(fork.id)?.markdown === "MOCK: in the fork", "fork reply");
    expect(items(fork.id).some((i) => i.type === "notice")).toBe(false);
  }, 60_000);

  it("recovers after the app-server crashes", async () => {
    const ready = new Promise((r) => host.manager.once("ready", r));
    host.manager.killForTest("codex-mock");
    await ready;
    // The runtime resubscribes on "ready"; the next turn must work without any manual step.
    await until(() => host.manager.handle("codex-mock") !== null, "handle");
    await new Promise((r) => setTimeout(r, 300));
    await host.runtime.sendMessage(mainId, "after crash");
    await until(() => lastAgent(mainId)?.markdown === "MOCK: after crash", "reply after crash");
  }, 90_000);

  it("survives a Host restart: data reloads and the adopted server keeps the thread", async () => {
    host.manager.detachAll();
    host.store.close();
    hosts.splice(hosts.indexOf(host), 1);

    host = startHost();
    expect(host.store.listSessions({ taskId }).map((s) => s.id)).toContain(mainId);
    expect(lastAgent(mainId)!.markdown).toBe("MOCK: after crash");
    await host.manager.ensure("codex-mock");
    await new Promise((r) => setTimeout(r, 300));
    await host.runtime.sendMessage(mainId, "after host restart");
    await until(() => lastAgent(mainId)?.markdown === "MOCK: after host restart", "reply after host restart");
  }, 90_000);

  it("archives the session with its fork and blocks further writes", async () => {
    const archived = await host.runtime.archive(mainId);
    expect(archived.map((s) => s.kind).sort()).toEqual(["fork", "main"]);
    await expect(host.runtime.sendMessage(mainId, "nope")).rejects.toThrow(/read-only/);
    const restored = await host.runtime.unarchive(mainId);
    expect(restored).toHaveLength(2);
    await host.runtime.sendMessage(mainId, "after unarchive");
    await until(() => lastAgent(mainId)?.markdown === "MOCK: after unarchive", "reply after unarchive");
  }, 90_000);
});
