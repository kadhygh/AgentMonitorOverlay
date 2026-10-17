import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, TINY_PNG_BASE64, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { writeClaudeLogin } from "./claude-login.js";

// Integration: Store + ClaudeRuntime + the real Claude Agent SDK against the mock Anthropic API, in a temp
// CLAUDE_CONFIG_DIR. Covers a turn, approvals, queued messages, interrupt, resume and a Host restart. No model budget.

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];
// Created in beforeAll, not at import: when every test is filtered out the hooks do not run and nothing would remove it.
let root: string;
let claudeHome: string;
let wsDir: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;

function startRuntime(): ClaudeRuntime {
  return new ClaudeRuntime({
    store,
    profiles: PROFILES,
    providers: { mock: { baseUrl: mock.baseUrl } },
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    claudeHome,
  });
}

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const items = (sessionId: string) => store.listItems(sessionId);
const agentTexts = (sessionId: string) => items(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const status = (sessionId: string) => store.getSession(sessionId)!.status;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-runtime-"));
  claudeHome = join(root, "claude-home");
  wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  runtime = startRuntime();
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "claude", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("ClaudeRuntime", () => {
  it("starts with the chosen model and effort, and switches them in a running session", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "opts one", options: { model: "mock-claude-b", effort: "high" } });
    await until(() => agentTexts(s.id).includes("MOCK: opts one") && status(s.id) === "idle", "first reply");
    const first = mock.requests.filter((r) => r.lastUserText === "opts one" && r.tools.length).at(-1)!.body as Record<string, unknown>;
    // Claude Code sends the effort as output_config.effort.
    expect(first).toMatchObject({ model: "mock-claude-b", output_config: { effort: "high" } });
    await runtime.setOptions(s.id, { model: "mock-claude-c", effort: "low", permission: "plan" });
    await runtime.sendMessage(s.id, "opts two");
    await until(() => agentTexts(s.id).includes("MOCK: opts two") && status(s.id) === "idle", "second reply");
    const second = mock.requests.filter((r) => r.lastUserText === "opts two" && r.tools.length).at(-1)!.body as Record<string, unknown>;
    expect(second).toMatchObject({ model: "mock-claude-c", output_config: { effort: "low" } });
  }, 120_000);

  it("runs a turn and continues the same Claude session on the next message", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "hello" });
    expect(s).toMatchObject({ runtime: "claude", kind: "main", title: "hello" });
    expect(s.runtimeRef).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => agentTexts(s.id).includes("MOCK: hello") && status(s.id) === "idle", "first reply");
    expect(items(s.id).map((i) => i.type)).toEqual(["turn", "user", "agent"]);
    // The speed's measure: the model call's output tokens and its time from first output to end (as DSH).
    const turnItem = items(s.id).find((i) => i.type === "turn") as Extract<SessionItem, { type: "turn" }>;
    expect(turnItem.decode?.tokens).toBe(5);
    expect(turnItem.decode?.ms).toBeGreaterThanOrEqual(0);
    // The transcript lives in Studio's config dir, under the id Studio chose.
    const sent = await runtime.sendMessage(s.id, "again");
    expect(sent.mode).toBe("start");
    await until(() => agentTexts(s.id).includes("MOCK: again"), "second reply");
    const last = mock.requests.at(-1)!;
    expect(JSON.stringify(last.body.messages)).toContain("MOCK: hello"); // same conversation
    expect(existsSync(join(claudeHome, "projects"))).toBe(true);
    // Claude Code's own system prompt, as in a terminal; nothing of Studio's added.
    const system = JSON.stringify(last.body.system);
    expect(system.length).toBeGreaterThan(3000);
    expect(system).not.toContain("AMO Studio");
  }, 120_000);

  it("loads the project's CLAUDE.md as a terminal does, and its AGENTS.md when there is no CLAUDE.md", async () => {
    const sent = async (name: string, files: Record<string, string>) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      const ws = store.addWorkspace({ path: dir, name });
      const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace: ws, text: `md ${name}` });
      await until(() => agentTexts(s.id).includes(`MOCK: md ${name}`) && status(s.id) === "idle", `reply in ${name}`);
      return JSON.stringify(mock.requests.filter((r) => r.lastUserText === `md ${name}` && r.tools.length).at(-1)!.body);
    };
    const both = await sent("ws-both", { "CLAUDE.md": "CLAUDE-MD-MARKER", "AGENTS.md": "AGENTS-MD-MARKER" });
    expect(both).toContain("CLAUDE-MD-MARKER");
    expect(both).not.toContain("AGENTS-MD-MARKER");
    const agentsOnly = await sent("ws-agents", { "AGENTS.md": "AGENTS-ONLY-MARKER" });
    expect(agentsOnly).toContain("AGENTS-ONLY-MARKER");
  }, 120_000);

  it("waits for the person on a command, and runs it once approved", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[shell: mkdir approved-dir]]" });
    await until(() => status(s.id) === "awaiting-approval", "approval");
    const approval = items(s.id).find((i) => i.type === "approval")!;
    expect(approval).toMatchObject({ kind: "command", summary: "mkdir approved-dir", state: "pending" });
    expect(existsSync(join(wsDir, "approved-dir"))).toBe(false);
    await runtime.respondApproval(s.id, (approval as { approvalId: string }).approvalId, "accept");
    await until(() => agentTexts(s.id).includes("MOCK-DONE") && status(s.id) === "idle", "after approval");
    expect(existsSync(join(wsDir, "approved-dir"))).toBe(true);
    expect(items(s.id).find((i) => i.type === "approval")).toMatchObject({ state: "accepted" });
    expect(items(s.id).find((i) => i.type === "tool")).toMatchObject({ name: "shell", summary: "mkdir approved-dir", status: "completed" });
  }, 120_000);

  it("keeps the key out of the agent's commands", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[shell: echo T=$ANTHROPIC_AUTH_TOKEN B=$ANTHROPIC_BASE_URL]]" });
    await until(() => status(s.id) === "awaiting-approval", "approval");
    const approval = items(s.id).find((i) => i.type === "approval") as { approvalId: string };
    await runtime.respondApproval(s.id, approval.approvalId, "accept");
    await until(() => status(s.id) === "idle" && agentTexts(s.id).includes("MOCK-DONE"), "after approval");
    const detail = (items(s.id).find((i) => i.type === "tool") as { detail?: string }).detail ?? "";
    expect(detail).toMatch(/B=http:\/\/127\.0\.0\.1/); // the command really ran and expanded variables
    expect(detail).toMatch(/T= B=/);
    expect(detail).not.toContain("mock-key");
  }, 120_000);

  it("does not run a declined command", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[shell: mkdir declined-dir]]" });
    await until(() => status(s.id) === "awaiting-approval", "approval");
    const approval = items(s.id).find((i) => i.type === "approval") as { approvalId: string };
    await runtime.respondApproval(s.id, approval.approvalId, "decline");
    await until(() => status(s.id) === "idle" && agentTexts(s.id).length > 0, "after decline");
    expect(existsSync(join(wsDir, "declined-dir"))).toBe(false);
    expect(items(s.id).find((i) => i.type === "tool")).toMatchObject({ status: "declined" });
  }, 120_000);

  it("queues a message sent during a turn, and interrupts a slow reply", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[slow]]" });
    await until(() => status(s.id) === "running" && items(s.id).some((i) => i.type === "agent"), "slow reply started");
    expect((await runtime.sendMessage(s.id, "next one")).mode).toBe("queue");
    await until(() => agentTexts(s.id).includes("MOCK: next one") && status(s.id) === "idle", "queued message answered");

    await runtime.sendMessage(s.id, "[[slow]]");
    await until(() => status(s.id) === "running" && items(s.id).filter((i) => i.type === "agent").length >= 3, "second slow reply");
    await runtime.interrupt(s.id);
    await until(() => status(s.id) === "idle", "interrupted");
    expect(items(s.id).some((i) => i.type === "error")).toBe(false);
    // The session goes on afterwards (a new query resumes it).
    await runtime.sendMessage(s.id, "after interrupt");
    await until(() => agentTexts(s.id).includes("MOCK: after interrupt"), "reply after interrupt");
  }, 180_000);

  it("sends images as image blocks, with or without text, also when queued", async () => {
    const id = "att-00000000-0000-4000-8000-000000000002";
    const path = join(root, `${id}.png`);
    writeFileSync(path, Buffer.from(TINY_PNG_BASE64, "base64"));
    const image = { id, name: "dot.png", mime: "image/png", size: 68, path, createdAt: "" };
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace });
    await runtime.sendMessage(s.id, "", [image]);
    await until(() => agentTexts(s.id).includes("MOCK:  [images: 1]") && status(s.id) === "idle", "reply to the image");
    expect(store.getSession(s.id)!.title).toBe("图片");
    expect(items(s.id).find((i) => i.type === "user")).toMatchObject({ text: "", images: [{ id, path }] });
    const sent = mock.requests.filter((r) => r.images === 1 && r.tools.length).at(-1)!.body as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(sent.messages)).toContain(TINY_PNG_BASE64);

    await runtime.sendMessage(s.id, "[[slow]]");
    await until(() => status(s.id) === "running" && items(s.id).some((i) => i.type === "agent" && i.streaming), "slow reply");
    expect((await runtime.sendMessage(s.id, "this too", [image])).mode).toBe("queue");
    await until(() => agentTexts(s.id).includes("MOCK: this too [images: 1]") && status(s.id) === "idle", "queued image answered");
    expect(items(s.id).filter((i) => i.type === "user").at(-1)).toMatchObject({ text: "this too", images: [{ id }] });
  }, 180_000);

  it("forks a session: the branch carries the context and goes its own way", async () => {
    const parent = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "remember the apples" });
    await until(() => agentTexts(parent.id).includes("MOCK: remember the apples") && status(parent.id) === "idle", "parent reply");
    const branch = await runtime.fork(parent.id);
    expect(branch).toMatchObject({ kind: "fork", parentId: parent.id, runtime: "claude", title: "remember the apples · 分支" });
    expect(branch.runtimeRef).not.toBe(parent.runtimeRef);
    await runtime.sendMessage(branch.id, "in the branch");
    await until(() => agentTexts(branch.id).includes("MOCK: in the branch"), "branch reply");
    expect(JSON.stringify(mock.requests.at(-1)!.body.messages)).toContain("MOCK: remember the apples");
    expect(agentTexts(parent.id)).toEqual(["MOCK: remember the apples"]);
    const fresh = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace });
    await expect(runtime.fork(fresh.id)).rejects.toThrow(/还没有对话内容/);
  }, 120_000);

  it("runs the subscription on the person's own Claude Code login when they chose it; sessions keep the way they started", async () => {
    // A stand-in for ~/.claude with a login in it (the CLI sends its access token to the mock as it would to Anthropic).
    const mine = join(root, "my-claude");
    mkdirSync(mine, { recursive: true });
    const expiresAt = Date.now() + 365 * 24 * 3600_000;
    writeFileSync(join(mine, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-local-test", refreshToken: "sk-ant-ort01-local-test", expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
    const sub: ModelProfile = { id: "claude-sub", label: "Claude", runtime: "claude", provider: "mock-oauth", model: MOCK_CLAUDE_MODEL, credentialId: "claude-subscription" };
    const local = new ClaudeRuntime({
      store,
      profiles: [...PROFILES, sub],
      providers: { mock: { baseUrl: mock.baseUrl }, "mock-oauth": { baseUrl: mock.baseUrl, auth: "oauth" } },
      credentials: new StaticCredentialReader({ mock: "mock-key" }), // no subscription token saved
      claudeHome,
      localClaudeHome: mine,
    });
    try {
      // With the token way and no token, the subscription cannot start.
      await expect(local.startSession({ taskId: task.id, topicId: null, profileId: "claude-sub", workspace, text: "x" })).rejects.toThrow(/claude setup-token/);
      // The token cannot read the account's quota; Studio says so instead of showing numbers it does not have.
      expect((await local.usage("claude-sub", true))?.note).toMatch(/查不到用量百分比/);
      writeClaudeLogin(store, "local");
      // The local login can: 5 小时 and 每周 with their resets, as Claude Code's /usage reads them.
      const usage = await local.usage("claude-sub", true);
      expect(usage).toMatchObject({ note: null, windows: [{ label: "5 小时", usedPercent: 37 }, { label: "每周", usedPercent: 12 }] });
      expect(Date.parse(usage!.windows[0]!.resetsAt!) - Date.now()).toBeGreaterThan(90 * 60_000);
      const s = await local.startSession({ taskId: task.id, topicId: null, profileId: "claude-sub", workspace, text: "from my login" });
      await until(() => agentTexts(s.id).includes("MOCK: from my login") && status(s.id) === "idle", "local reply");
      expect(existsSync(join(mine, "projects"))).toBe(true);
      // Back to the token way: the session started with the local login goes on with it (its transcript is there).
      writeClaudeLogin(store, "token");
      await local.sendMessage(s.id, "still mine");
      await until(() => agentTexts(s.id).includes("MOCK: still mine") && status(s.id) === "idle", "second local reply");
      expect(JSON.stringify(mock.requests.at(-1)!.body.messages)).toContain("MOCK: from my login");
      // A branch stays with it too, and cannot move to another provider.
      const branch = await local.fork(s.id);
      await local.sendMessage(branch.id, "in my branch");
      await until(() => agentTexts(branch.id).includes("MOCK: in my branch"), "local branch reply");
      await expect(local.fork(s.id, "claude-mock")).rejects.toThrow(/只能继续用 Claude 订阅/);
      // New subscription sessions follow the setting again.
      await expect(local.startSession({ taskId: task.id, topicId: null, profileId: "claude-sub", workspace, text: "y" })).rejects.toThrow(/claude setup-token/);
    } finally {
      writeClaudeLogin(store, "token");
      await local.closeAll();
    }
  }, 180_000);

  it("groups a subagent's work in a child session under the Agent call", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[spawn: helper: say hi]]" });
    await until(() => status(s.id) === "idle" && agentTexts(s.id).includes("MOCK-DONE"), "spawn done");
    const line = items(s.id).find((i) => i.type === "subagent") as { childSessionId: string; summary: string } | undefined;
    expect(line?.summary).toBe("helper");
    expect(items(s.id).some((i) => i.type === "tool")).toBe(false); // no tool card for the Agent call itself
    const child = store.getSession(line!.childSessionId)!;
    expect(child).toMatchObject({ kind: "sub", parentId: s.id, runtime: "claude", title: "helper", status: "completed" });
    expect(items(child.id).map((i) => i.type)).toEqual(["user", "agent"]);
    expect(agentTexts(child.id)).toEqual(["MOCK-SUB: helper"]);
    await expect(runtime.sendMessage(child.id, "hi")).rejects.toThrow(/子 agent/);
  }, 120_000);

  it("asks the person before a subagent's command, even when the Agent call asks to bypass permissions", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[spawn-mode-bypassPermissions: helper: [[shell: mkdir sub-made-dir]]]]" });
    await until(() => status(s.id) === "awaiting-approval", "subagent approval");
    const approval = items(s.id).find((i) => i.type === "approval") as { approvalId: string; summary: string };
    expect(approval.summary).toBe("mkdir sub-made-dir");
    expect(existsSync(join(wsDir, "sub-made-dir"))).toBe(false);
    await runtime.respondApproval(s.id, approval.approvalId, "accept");
    await until(() => status(s.id) === "idle" && agentTexts(s.id).includes("MOCK-DONE"), "after subagent approval");
    expect(existsSync(join(wsDir, "sub-made-dir"))).toBe(true);
    const child = (items(s.id).find((i) => i.type === "subagent") as { childSessionId: string }).childSessionId;
    expect(items(child).find((i) => i.type === "tool")).toMatchObject({ name: "shell", summary: "mkdir sub-made-dir", status: "completed" });
    // Its model call's input (the mock reports 10) is counted in the child and on the parent's row (2026-10-17); its
    // output only as far as the CLI tells a subagent's messages (the count at the call's start).
    expect(items(child).find((i) => i.type === "turn")).toMatchObject({ state: "completed", usage: { input: 10 } });
    expect(items(s.id).find((i) => i.type === "subagent")).toMatchObject({ usage: { input: 10 } });
  }, 120_000);

  it("keeps a background subagent running until its notification arrives", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[spawn-bg: watcher: check later]]" });
    await until(() => items(s.id).some((i) => i.type === "subagent"), "background subagent");
    const child = (items(s.id).find((i) => i.type === "subagent") as { childSessionId: string }).childSessionId;
    await until(() => status(child) === "completed", "background subagent completed");
    await until(() => status(s.id) === "idle" && agentTexts(s.id).filter((t) => t === "MOCK-DONE").length >= 2, "parent's second turn");
    expect(agentTexts(child)).toEqual(["MOCK-SUB: watcher"]);
  }, 120_000);

  it("after a crash, marks turns that were in flight as over", async () => {
    // As a crashed Host leaves it: no process, the session still awaiting approval, a card still pending.
    const s = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "claude", profileId: "claude-mock", workspaceId: workspace.id, title: "crashed", status: "awaiting-approval", writer: "workbench", runtimeRef: "00000000-0000-4000-8000-000000000000" });
    store.appendItem({ id: "i-crash-approval", sessionId: s.id, createdAt: new Date().toISOString(), type: "approval", approvalId: "t1", kind: "command", summary: "mkdir x", state: "pending" });
    store.appendItem({ id: "i-crash-agent", sessionId: s.id, createdAt: new Date().toISOString(), type: "agent", markdown: "half", streaming: true });
    const recovered = startRuntime();
    expect(status(s.id)).toBe("idle");
    expect(items(s.id).map((i) => [i.type, (i as { state?: string }).state ?? (i as { streaming?: boolean }).streaming ?? null])).toEqual([
      ["approval", "resolved-elsewhere"],
      ["agent", false],
      ["notice", null],
    ]);
    await recovered.closeAll();
  });

  it("ends in-flight turns when the Host restarts", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[shell: mkdir restart-dir]]" });
    await until(() => status(s.id) === "awaiting-approval", "approval before restart");
    await runtime.closeAll();
    runtime = startRuntime();
    expect(status(s.id)).toBe("idle");
    expect(items(s.id).find((i) => i.type === "approval")).toMatchObject({ state: "resolved-elsewhere" });
    expect(items(s.id).filter((i) => i.type === "notice")).toHaveLength(1);
    await runtime.sendMessage(s.id, "still there?");
    await until(() => agentTexts(s.id).includes("MOCK: still there?"), "reply after restart");
  }, 120_000);
});
