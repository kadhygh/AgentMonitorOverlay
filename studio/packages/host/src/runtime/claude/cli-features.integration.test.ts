import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, MOCK_SUGGESTION, TINY_PNG_BASE64, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { writeChatSettings } from "../chat-settings.js";
import { ClaudeRuntime, claudeCommands, localCommandText, retryReason } from "./claude-runtime.js";

// Stage 12, S12-E: Claude Code's CLI features as they reach Studio — / commands, local command output, compaction,
// background commands, image results, retries, prompt suggestions — with the real CLI against the mock Anthropic API.

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];
let root: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const items = (id: string) => store.listItems(id);
const ofType = <T extends SessionItem["type"]>(id: string, type: T) => items(id).filter((i): i is Extract<SessionItem, { type: T }> => i.type === type);
const idle = (id: string) => store.getSession(id)!.status === "idle";
const start = (text: string) => runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text });
/** Commands wait for the person (every Bash call asks in Studio's default mode). */
async function approve(sessionId: string): Promise<void> {
  await until(() => ofType(sessionId, "approval").some((a) => a.state === "pending"), "approval");
  const pending = ofType(sessionId, "approval").find((a) => a.state === "pending")!;
  await runtime.respondApproval(sessionId, pending.approvalId, "accept");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-cli-"));
  const wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "pic.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  runtime = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: { baseUrl: mock.baseUrl } }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome: join(root, "claude-home") });
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "cli", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("Claude Code CLI features", () => {
  it("lists Claude Code's commands without a running session, leaving out the ones Studio keeps itself", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace });
    const { commands, note } = await runtime.listCommands(s.id);
    expect(note).toBeUndefined();
    const names = commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["context", "usage", "init", "code-review"]));
    for (const hidden of ["clear", "model", "effort", "compact", "rename", "agents"]) expect(names).not.toContain(hidden);
    expect(commands.find((c) => c.name === "usage")).toMatchObject({ group: "runtime", aliases: ["cost", "stats"] });
  }, 60_000);

  it("shows a local command's output as a record, and compacts the context", async () => {
    const s = await start("hello");
    await until(() => ofType(s.id, "agent").some((a) => a.markdown === "MOCK: hello") && idle(s.id), "first reply");
    await runtime.runCommand(s.id, "cost", "");
    await until(() => ofType(s.id, "command").length === 1 && idle(s.id), "command output");
    expect(ofType(s.id, "command")[0]).toMatchObject({ name: "cost" });
    expect(ofType(s.id, "command")[0]!.output).toMatch(/^Total cost/);
    expect(ofType(s.id, "agent")).toHaveLength(1); // the output is not a reply
    expect(ofType(s.id, "user").map((u) => u.text)).toEqual(["hello", "/cost"]);

    await runtime.runCommand(s.id, "compact", "");
    await until(() => ofType(s.id, "compaction").some((c) => c.state === "completed") && idle(s.id), "compaction");
    const [compaction] = ofType(s.id, "compaction");
    expect(compaction).toMatchObject({ state: "completed", trigger: "manual" });
    expect(compaction!.beforeTokens).toBeGreaterThan(0);
    // The turn's context readout follows what is left.
    const turns = ofType(s.id, "turn");
    expect(turns.at(-1)!.usage?.context).toBe(compaction!.afterTokens);
  }, 120_000);

  it("refuses commands that would change the session behind Studio's back", async () => {
    const s = await start("one");
    await until(() => idle(s.id) && ofType(s.id, "agent").length === 1, "reply");
    await expect(runtime.sendMessage(s.id, "/clear")).rejects.toThrow(/新建一个会话/);
    await expect(runtime.sendMessage(s.id, "/model opus")).rejects.toThrow(/型号/);
  }, 60_000);

  it("lists a background command until it ends, with its output file", async () => {
    const s = await start("[[bg: ping -n 3 127.0.0.1]]");
    await approve(s.id);
    await until(() => ofType(s.id, "background").length === 1, "background item");
    expect(ofType(s.id, "background")[0]).toMatchObject({ command: "ping -n 3 127.0.0.1", state: "running" });
    await until(() => ofType(s.id, "background")[0]!.state !== "running", "background end", 30_000);
    const done = ofType(s.id, "background")[0]!;
    expect(done.state).toBe("completed");
    expect(done.outputFile).toMatch(/\.output$/);
    expect(done.summary).toContain("completed");
  }, 90_000);

  it("stops a background command", async () => {
    const s = await start("[[bg: ping -n 60 127.0.0.1]]");
    await approve(s.id);
    await until(() => ofType(s.id, "background").length === 1 && idle(s.id), "background item");
    const bg = ofType(s.id, "background")[0]!;
    await runtime.stopBackground(s.id, bg.taskId);
    await until(() => ofType(s.id, "background")[0]!.state !== "running", "stopped", 30_000);
    expect(ofType(s.id, "background")[0]!.state).toBe("stopped");
  }, 90_000);

  it("shows an image file read by the agent on its tool row", async () => {
    const file = join(workspace.path, "pic.png");
    const s = await start(`[[read-image: ${file}]]`);
    await until(() => idle(s.id) && ofType(s.id, "agent").some((a) => a.markdown === "MOCK-DONE"), "reply");
    const read = ofType(s.id, "tool").find((t) => t.name === "read")!;
    expect(read.images).toEqual([{ id: null, path: file }]);
  }, 60_000);

  it("shows a retry on the turn while the API is overloaded, then clears it", async () => {
    const seen: Array<{ attempt: number; reason: string }> = [];
    runtime.on("event", (e) => {
      if (e.type === "item.updated" && e.item.type === "turn" && e.item.retry) seen.push(e.item.retry);
    });
    const s = await start("[[retry]] please");
    await until(() => idle(s.id) && ofType(s.id, "agent").some((a) => a.markdown === "MOCK: [[retry]] please"), "reply after retries", 90_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ attempt: 1, reason: "服务繁忙（529）" });
    expect(ofType(s.id, "turn").at(-1)!.retry).toBeUndefined();
    expect(ofType(s.id, "error")).toHaveLength(0);
  }, 120_000);

  it("turns a refusal into notices instead of dropping it", async () => {
    const s = await start("[[refuse]] please");
    // The CLI ends the turn as an error after the refusal; its own "API Error" text stays as the reply.
    await until(() => store.getSession(s.id)!.status === "error" && ofType(s.id, "notice").length >= 2, "notices", 60_000);
    const notices = ofType(s.id, "notice").map((n) => n.message);
    expect(notices).toEqual(expect.arrayContaining([expect.stringContaining("safeguards stopped the response"), `模型 ${MOCK_CLAUDE_MODEL} 拒绝了这次请求。`]));
    // No generic error row on top of them.
    expect(ofType(s.id, "error")).toHaveLength(0);
  }, 90_000);

  it("offers Claude's suggested next message after a reply when turned on (off by default)", async () => {
    writeChatSettings(store, { promptSuggestions: true });
    const s = await start("[[suggest]] first");
    await until(() => idle(s.id) && ofType(s.id, "agent").length === 1, "first reply");
    await runtime.sendMessage(s.id, "second");
    await until(() => ofType(s.id, "suggestion").length > 0, "suggestion");
    expect(ofType(s.id, "suggestion").at(-1)!.text).toBe(MOCK_SUGGESTION);

    writeChatSettings(store, { promptSuggestions: false });
    try {
      const off = await start("[[suggest]] again");
      await until(() => idle(off.id) && ofType(off.id, "agent").length === 1, "reply");
      await runtime.sendMessage(off.id, "and again");
      await until(() => idle(off.id) && ofType(off.id, "agent").length === 2, "second reply");
      await new Promise((r) => setTimeout(r, 1500));
      expect(ofType(off.id, "suggestion")).toHaveLength(0);
    } finally {
      writeChatSettings(store, { promptSuggestions: false });
    }
  }, 120_000);
});

describe("Claude CLI helpers", () => {
  it("groups commands and drops hidden, removed and internal ones", () => {
    const list = claudeCommands(
      [
        { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
        { name: "dataviz", description: "Charts", argumentHint: "", builtin: true },
        { name: "deploy", description: "Ship it", argumentHint: "<env>" },
        { name: "deploy", description: "Built-in deploy", argumentHint: "", builtin: true },
        { name: "clear", description: "Start a new session", argumentHint: "", builtin: true, aliases: ["reset", "new"] },
        { name: "agents", description: "(removed) Ask Claude", argumentHint: "", builtin: true },
        { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
      ],
      new Set(["dataviz"]),
    );
    expect(list).toEqual([
      { name: "context", description: "Show current context usage", group: "runtime" },
      { name: "dataviz", description: "Charts", group: "skill" },
      { name: "deploy", description: "Built-in deploy", group: "runtime" },
    ]);
  });

  it("strips the stdout tags of a local command and names retry reasons", () => {
    expect(localCommandText("<local-command-stdout>Total cost: $0</local-command-stdout>")).toBe("Total cost: $0");
    expect(retryReason("overloaded", 529)).toBe("服务繁忙（529）");
    expect(retryReason("rate_limit", null)).toBe("触发限流");
    expect(retryReason("", 500)).toBe("请求失败（500）");
  });
});
