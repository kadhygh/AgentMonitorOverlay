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
import { McpIdentities, MCP_SESSION_HEADER } from "./identity.js";

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
let identities: McpIdentities;
let mainSessionId: string;
let configSessionId: string;

async function connect(token = TOKEN, sessionToken?: string): Promise<Client> {
  const client = new Client({ name: "amo-test", version: "0" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(sessionToken ? { [MCP_SESSION_HEADER]: sessionToken } : {}) };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), { requestInit: { headers } }));
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
  identities = new McpIdentities(store);
  http = await startHostServer({ service, token: TOKEN, mcpToken: MCP_TOKEN, mcpIdentities: identities });

  const alpha = service.addWorkspace({ path: join(root, "alpha") });
  const beta = service.addWorkspace({ path: join(root, "beta") });
  importTask = store.createTask({ title: "导入重试", scope: { kind: "workspace", workspaceId: alpha.id } });
  configTask = store.createTask({ title: "统一配置键", scope: { kind: "area" }, column: "doing" });
  const main = store.createSession({ taskId: importTask.id, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "计划", status: "awaiting-approval", writer: "workbench", runtimeRef: "t1" });
  mainSessionId = main.id;
  store.createSession({ taskId: importTask.id, parentId: main.id, kind: "fork", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "退避方案", status: "idle", writer: "workbench", runtimeRef: "t2" });
  store.appendItem({ id: "i1", sessionId: main.id, createdAt: new Date().toISOString(), type: "agent", markdown: "x".repeat(400), streaming: false });
  configSessionId = store.createSession({ taskId: configTask.id, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: beta.id, title: "", status: "idle", writer: "workbench", runtimeRef: "t3" }).id;
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
  it("lists five read-only tools and five that write for the caller", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["board_list", "canvas_read", "decision_request", "handoff_submit", "mailbox_read", "mailbox_send", "project_context", "session_tree", "task_get", "task_note_add"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort()).toEqual(["board_list", "canvas_read", "project_context", "session_tree", "task_get"]);
    await client.close();
  });

  it("writes only for an identified caller, and only to the caller's own task", async () => {
    const anonymous = await connect(MCP_TOKEN);
    const refused = await call(anonymous, "task_note_add", { text: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/没有 AMO 会话身份/);
    await anonymous.close();
    expect((await call(await connect(MCP_TOKEN, "not-a-session-token"), "task_note_add", { text: "x" })).isError).toBe(true);

    const token = identities.tokenFor(mainSessionId);
    expect(identities.tokenFor(mainSessionId)).toBe(token);
    expect(identities.sessionFor(token)).toBe(mainSessionId);
    const client = await connect(MCP_TOKEN, token);
    const note = (await call(client, "task_note_add", { text: "重试已加上，还差测试" })).data;
    expect(note).toMatchObject({ taskId: importTask.id, sessionId: mainSessionId, kind: "progress" });
    const handoff = (await call(client, "handoff_submit", { summary: "交接：importer.ts 已改，测试在 tests/import" })).data;
    expect(handoff).toMatchObject({ taskId: importTask.id, kind: "handoff" });
    expect((await call(client, "task_note_add", { text: " " })).isError).toBe(true);
    expect(service.taskNotes(importTask.id).map((n) => n.kind)).toEqual(["progress", "handoff"]);
    expect(service.taskNotes(configTask.id)).toEqual([]);
    await client.close();
  });

  it("leaves mail for another session or task, and the recipient reads it once", async () => {
    const sender = await connect(MCP_TOKEN, identities.tokenFor(mainSessionId));
    expect((await call(sender, "mailbox_send", { toSessionId: configSessionId, text: "导入接口改好了" })).data).toMatchObject({ to: { kind: "session", sessionId: configSessionId }, state: "unread" });
    expect((await call(sender, "mailbox_send", { toTaskId: configTask.id, text: "记得同步配置键" })).data).toMatchObject({ to: { kind: "task" } });
    expect((await call(sender, "mailbox_send", { text: "nobody" })).isError).toBe(true);
    expect((await call(sender, "mailbox_send", { toSessionId: mainSessionId, text: "me" })).isError).toBe(true);
    await sender.close();

    const reader = await connect(MCP_TOKEN, identities.tokenFor(configSessionId));
    const read = (await call(reader, "mailbox_read")).data as { messages: Array<{ from: { sessionId: string } | string; text: string }> };
    expect(read.messages.map((m) => m.text)).toEqual(["导入接口改好了", "记得同步配置键"]);
    expect(read.messages[0]!.from).toMatchObject({ sessionId: mainSessionId, title: "计划" });
    expect(((await call(reader, "mailbox_read")).data as { messages: unknown[] }).messages).toEqual([]);
    expect(service.mail({ forTaskId: configTask.id }).map((m) => m.state)).toEqual(["read", "read"]);
    await reader.close();
  });

  it("opens /mcp, and only /mcp, with the MCP token", async () => {
    const client = await connect(MCP_TOKEN);
    expect((await client.listTools()).tools).toHaveLength(10);
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

  it("asks the person for a decision; the answer comes back as mail", async () => {
    const client = await connect(MCP_TOKEN, identities.tokenFor(mainSessionId));
    const asked = (await call(client, "decision_request", { question: "重试几次？", options: ["3 次", "5 次"] })).data;
    expect(asked).toMatchObject({ state: "open" });
    expect(service.decisions({ state: "open" })).toMatchObject([{ id: asked.id, sessionId: mainSessionId, taskId: importTask.id, options: ["3 次", "5 次"] }]);
    expect((await call(client, "decision_request", { question: " " })).isError).toBe(true);
    service.answerDecision(asked.id, "3 次");
    const read = (await call(client, "mailbox_read")).data as { messages: Array<{ text: string; from: unknown }> };
    expect(read.messages).toMatchObject([{ text: "针对你的问题「重试几次？」，我的决定：3 次", from: "person" }]);
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
