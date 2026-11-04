import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer, mockClaudeProvider } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import type { McpLaunch } from "../mcp-launch.js";
import { ClaudeRuntime } from "./claude-runtime.js";

// MCP 设置 (2026-11-04) against the real Claude Agent SDK and CLI (mock Anthropic API): Studio's servers reach the
// process at start and while it runs (setMcpServers, amo kept), names denied through managedSettings stay out without
// a file written, and a change of the person's own servers waits for a new process.

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];

let root: string;
let claudeHome: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;
let plan: McpLaunch;
let serverScript: string;

const until = async (pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const agentTexts = (sessionId: string) => store.listItems(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const status = (sessionId: string) => store.getSession(sessionId)!.status;
const stdio = (tag: string) => ({ type: "stdio" as const, command: process.execPath, args: [serverScript, tag] });

// A minimal MCP server over stdio (newline-delimited JSON-RPC): one tool, `ping`.
const SERVER = `
const tag = process.argv[2] || "x";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result;
    if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: tag, version: "1" } };
    else if (m.method === "tools/list") result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    else if (m.method === "tools/call") result = { content: [{ type: "text", text: "pong-" + tag }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\\n"); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-mcp-"));
  claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  serverScript = join(root, "mcp-server.cjs");
  writeFileSync(serverScript, SERVER);
  // The config dir's own user-level servers, as a person's ~/.claude.json would have them.
  writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify({ mcpServers: { "own-a": stdio("own-a"), "own-b": stdio("own-b") } }));
  const wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  plan = { explicit: { studio1: stdio("studio1") }, deny: [], enableJson: [], strict: true };
  runtime = new ClaudeRuntime({
    store,
    profiles: PROFILES,
    providers: { mock: mockClaudeProvider(mock.baseUrl) },
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    claudeHome,
    mcp: { launch: () => plan },
    mcpTools: () => [{ name: "hello", title: "hello", description: "says hello", inputSchema: { who: z.string().optional() }, readOnly: true, autoApprove: true, run: () => ({ content: [{ type: "text", text: "amo-still-here" }] }) }],
  });
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "mcp", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

const names = async (sessionId: string) => Object.fromEntries(((await runtime.mcpStatus(sessionId)) ?? []).map((x) => [x.name, x.status]));

describe("Claude sessions and MCP 设置", () => {
  it("gives Studio's servers at start and while running, keeping amo", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "one" });
    await until(() => agentTexts(s.id).includes("MOCK: one") && status(s.id) === "idle", "first reply");
    await until(async () => (await names(s.id)).studio1 === "connected", "studio1 connected");
    // strict: the config dir's own servers are not loaded.
    expect(await names(s.id)).not.toHaveProperty("own-a");

    // Added while it runs: there at once; one added that way can go again at once.
    plan = { ...plan, explicit: { studio1: stdio("studio1"), studio2: stdio("studio2"), studio3: stdio("studio3") } };
    expect(await runtime.refreshMcp(s.id)).toBe("now");
    await until(async () => (await names(s.id)).studio3 === "connected", "studio3 connected");
    plan = { ...plan, explicit: { studio1: stdio("studio1"), studio2: stdio("studio2") } };
    expect(await runtime.refreshMcp(s.id)).toBe("now");
    await until(async () => !("studio3" in (await names(s.id))), "studio3 gone");
    expect(await names(s.id)).toMatchObject({ studio1: "connected", studio2: "connected" });
    // The AMO server is still there and answers.
    await runtime.sendMessage(s.id, "[[mcp: hello]]");
    await until(() => agentTexts(s.id).some((t) => t.includes("MOCK-MCP: amo-still-here")) && status(s.id) === "idle", "amo tool");
    // One given at the start cannot be taken from a running process: a new one, on the next message.
    plan = { ...plan, explicit: { studio2: stdio("studio2") } };
    expect(await runtime.refreshMcp(s.id)).toBe("next-message");
    await runtime.sendMessage(s.id, "four");
    await until(() => agentTexts(s.id).includes("MOCK: four") && status(s.id) === "idle", "after restart");
    await until(async () => (await names(s.id)).studio2 === "connected", "studio2 after restart");
    expect(await names(s.id)).not.toHaveProperty("studio1");
    await runtime.closeAll();
  }, 180_000);

  it("loads the config dir's own servers when not strict, minus the denied ones; a change of those waits for a new process", async () => {
    plan = { explicit: {}, deny: ["own-b"], enableJson: [], strict: false };
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "two" });
    await until(() => agentTexts(s.id).includes("MOCK: two") && status(s.id) === "idle", "reply");
    await until(async () => (await names(s.id))["own-a"] === "connected", "own-a connected");
    const now = await names(s.id);
    expect(now["own-b"] === undefined || now["own-b"] === "disabled" || now["own-b"] === "failed").toBe(true);
    expect(now["own-b"]).not.toBe("connected");

    // Denying another of the person's needs a new process: closed now (idle), resumed on the next message.
    plan = { ...plan, deny: ["own-a", "own-b"] };
    expect(await runtime.refreshMcp(s.id)).toBe("next-message");
    expect(await runtime.mcpStatus(s.id)).toBeNull();
    await runtime.sendMessage(s.id, "three");
    await until(() => agentTexts(s.id).includes("MOCK: three") && status(s.id) === "idle", "after restart");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await names(s.id))["own-a"]).not.toBe("connected");
    // The same conversation went on.
    expect(JSON.stringify(mock.requests.at(-1)!.body.messages)).toContain("MOCK: two");
  }, 180_000);
});
