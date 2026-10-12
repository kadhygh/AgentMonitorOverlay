import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { startHostServer, type HostServer } from "../http/server.js";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";

// The AMO MCP over HTTP with the official MCP client: tools, read-only annotations, auth, and what each tool returns.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";
const MCP_TOKEN = "test-mcp-token";
let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;
let service: HostService;
let importTask: Task;
let configTask: Task;

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: "amo-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...r, data: r.isError ? null : JSON.parse(r.content.at(-1)!.text) };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-mcp-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, mcpToken: MCP_TOKEN });

  const alpha = service.addWorkspace({ path: join(root, "alpha") });
  const beta = service.addWorkspace({ path: join(root, "beta") });
  importTask = store.createTask({ title: "导入重试", scope: { kind: "workspace", workspaceId: alpha.id } });
  configTask = store.createTask({ title: "统一配置键", scope: { kind: "area" }, column: "doing" });
  const main = store.createSession({ taskId: importTask.id, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "计划", status: "awaiting-approval", writer: "workbench", runtimeRef: "t1" });
  store.createSession({ taskId: importTask.id, parentId: main.id, kind: "fork", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "退避方案", status: "idle", writer: "workbench", runtimeRef: "t2" });
  store.appendItem({ id: "i1", sessionId: main.id, createdAt: new Date().toISOString(), type: "agent", markdown: "x".repeat(400), streaming: false });
  store.createSession({ taskId: configTask.id, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: beta.id, title: "", status: "idle", writer: "workbench", runtimeRef: "t3" });
  const canvas = service.canvas();
  service.saveCanvas({
    ...canvas,
    groups: [{ id: "g1", title: "导入", workspaceId: alpha.id, rect: { x: 0, y: 0, w: 400, h: 300 } }],
    nodes: [
      { id: "n1", kind: "task", taskId: importTask.id, groupId: "g1", pos: { x: 10, y: 40 } },
      { id: "n2", kind: "task", taskId: configTask.id, groupId: null, pos: { x: 600, y: 40 } },
    ],
    edges: [{ id: "e1", kind: "depends", from: configTask.id, to: importTask.id }],
  });
});

afterAll(async () => {
  await http?.close();
  await servers?.close();
  store?.close();
  if (root) removeTempDir(root);
});

describe("AMO MCP", () => {
  it("lists five read-only tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["board_list", "canvas_read", "project_context", "session_tree", "task_get"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it("opens /mcp, and only /mcp, with the MCP token", async () => {
    const client = await connect(MCP_TOKEN);
    expect((await client.listTools()).tools).toHaveLength(5);
    await client.close();
    const res = await fetch(`${http.url}/api/state`, { headers: { authorization: `Bearer ${MCP_TOKEN}`, connection: "close" } });
    expect(res.status).toBe(401);
  });

  it("needs the Host token", async () => {
    await expect(connect("wrong")).rejects.toThrow();
    const res = await fetch(`${http.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("reads the board, a task, its session tree, the workspaces and the canvas", async () => {
    const client = await connect();
    const board = await call(client, "board_list");
    expect(board.data.tasks.map((t: { title: string; status: string | null; workspace: string }) => [t.title, t.status, t.workspace]).sort()).toEqual([
      ["导入重试", "awaiting-approval", "alpha"],
      ["统一配置键", "idle", "跨工作区（beta）"],
    ]);
    expect((await call(client, "board_list", { workspace: "beta" })).data.tasks.map((t: { title: string }) => t.title)).toEqual(["统一配置键"]);
    expect((await call(client, "board_list", { column: "doing" })).data.tasks.map((t: { title: string }) => t.title)).toEqual(["统一配置键"]);

    const task = (await call(client, "task_get", { taskId: importTask.id })).data;
    expect(task).toMatchObject({ title: "导入重试", canvasGroup: "导入", dependsOn: [{ id: configTask.id, title: "统一配置键" }], dependents: [] });
    expect(task.sessions).toHaveLength(2);

    const tree = (await call(client, "session_tree", { taskId: importTask.id })).data;
    expect(tree.sessions).toHaveLength(1);
    expect(tree.sessions[0]).toMatchObject({ kind: "main", title: "计划", model: "Codex · DS", workspace: "alpha" });
    expect(tree.sessions[0].lastReply).toHaveLength(301); // 300 characters and an ellipsis, never the full transcript
    expect(tree.sessions[0].children[0]).toMatchObject({ kind: "fork", title: "退避方案" });

    const ctx = (await call(client, "project_context")).data;
    expect(ctx.workspaces.map((w: { name: string; openTasks: number }) => [w.name, w.openTasks])).toEqual([
      ["alpha", 1],
      ["beta", 0],
    ]);
    expect((await call(client, "project_context", { workspace: "alpha" })).data.openTasks.map((t: { title: string }) => t.title)).toEqual(["导入重试"]);

    const canvas = (await client.callTool({ name: "canvas_read", arguments: {} })) as { content: Array<{ text: string }> };
    expect(canvas.content[0]!.text).toContain("分组「导入」（工作区 alpha）");
    expect(JSON.parse(canvas.content[1]!.text).dependencies).toEqual([{ from: configTask.id, to: importTask.id }]);
    expect(canvas.content[1]!.text).not.toMatch(/"pos"|"rect"/);
    await client.close();
  });

  it("answers an unknown id with a readable tool error", async () => {
    const client = await connect();
    const r = await call(client, "task_get", { taskId: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("task nope not found");
    await client.close();
  });
});
