import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { LIMIT_CONTINUE_TEXT } from "./wake.js";

// Stage 15 (2026-10-16): the agent's /loop, usage limits and agents resumed with SendMessage. Real SDK against the mock
// API; the messages the mock cannot produce (ScheduleWakeup, a claude.ai usage limit, SendMessage resuming an agent) are
// fed to the runtime as the CLI sends them (shapes from the 2026-10-15/16 transcripts of a real loop).

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];
let root: string;
let claudeHome: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;

type Internals = {
  live: Map<string, unknown>;
  onMessage(sessionId: string, live: unknown, m: unknown): void;
  askPerson(sessionId: string, live: unknown, toolName: string, input: Record<string, unknown>, ctx: { signal: AbortSignal; toolUseID?: string }): Promise<unknown>;
};
const internals = () => runtime as unknown as Internals;
const alive = (sessionId: string) => internals().live.has(sessionId);
/** Hands the runtime one message as if its Claude Code process had sent it. */
const feed = (sessionId: string, m: Record<string, unknown>) => {
  const live = internals().live.get(sessionId);
  if (!live) throw new Error(`no process for ${sessionId}`);
  internals().onMessage(sessionId, live, { parent_tool_use_id: null, ...m });
};
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });
const toolResult = (id: string, text: string, result: unknown) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] }, tool_use_result: result });
const result = (isError = false) => ({ type: "result", subtype: "success", is_error: isError, usage: {}, modelUsage: {} });
const scheduleWakeup = (sessionId: string, id: string, scheduledFor: number, prompt = "loop tick") => {
  feed(sessionId, assistant([{ type: "tool_use", id, name: "ScheduleWakeup", input: { delaySeconds: 1800, reason: "等子 agent", prompt } }]));
  feed(sessionId, toolResult(id, "Next wakeup scheduled", { scheduledFor, clampedDelaySeconds: 1800 }));
};

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const items = (sessionId: string) => store.listItems(sessionId);
const agentTexts = (sessionId: string) => items(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const session = (sessionId: string) => store.getSession(sessionId)!;

async function started(text: string) {
  const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text });
  await until(() => agentTexts(s.id).includes(`MOCK: ${text}`) && session(s.id).status === "idle", `reply to ${text}`);
  return s;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-wake-"));
  claudeHome = join(root, "claude-home");
  const wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  runtime = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: { baseUrl: mock.baseUrl } }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome, idleCloseMs: 300 });
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "loop", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("ClaudeRuntime: loop and usage limits", () => {
  it("keeps the process while a loop wakeup is pending, and lets it go once the loop has ended", async () => {
    const s = await started("loop one");
    const at = Date.now() + 1_800_000;
    scheduleWakeup(s.id, "toolu_w1", at);
    feed(s.id, result());
    expect(session(s.id).wake).toEqual({ loop: { at: new Date(at).toISOString(), reason: "等子 agent", prompt: "loop tick" } });
    await sleep(900); // three idle periods
    expect(alive(s.id)).toBe(true);
    // The wakeup fired (its time is past) and that turn ended without scheduling another: the loop is over.
    scheduleWakeup(s.id, "toolu_w2", Date.now() - 1000);
    feed(s.id, result());
    feed(s.id, assistant([{ type: "text", text: "all done" }]));
    feed(s.id, result());
    expect(session(s.id).wake).toBeUndefined();
    await until(() => !alive(s.id), "idle close");
  }, 120_000);

  it("stops a loop when asked: the wake is cleared and the process (with the CLI's wakeup) closed", async () => {
    const s = await started("loop stop");
    scheduleWakeup(s.id, "toolu_w3", Date.now() + 1_800_000);
    feed(s.id, result());
    const after = await runtime.setWakeChoice(s.id, { stopLoop: true });
    expect(after.wake).toBeUndefined();
    expect(alive(s.id)).toBe(false);
    expect(items(s.id).at(-1)).toMatchObject({ type: "notice", message: "你在 Studio 里停止了这条会话的 loop。" });
  }, 120_000);

  it("at a usage limit in a loop, goes on by itself after the reset with the loop's prompt", async () => {
    const s = await started("limit loop");
    scheduleWakeup(s.id, "toolu_w4", Date.now() + 1_800_000);
    feed(s.id, result());
    // The reset was 10 minutes ago, so Studio's grace has passed: it sends the loop's prompt at once.
    feed(s.id, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) - 600 } });
    feed(s.id, assistant([{ type: "text", text: "You've hit your session limit · resets 12:30am (Asia/Hong_Kong)" }], { error: "rate_limit" }));
    feed(s.id, result(true));
    await until(() => agentTexts(s.id).includes("MOCK: loop tick") && session(s.id).status === "idle", "Studio's continuation");
    expect(items(s.id).some((i) => i.type === "error")).toBe(false);
    // The limit is over; the loop's own wakeup is still pending.
    expect(session(s.id).wake?.limit).toBeUndefined();
    expect(session(s.id).wake?.loop?.prompt).toBe("loop tick");
  }, 120_000);

  it("outside a loop, waits at a usage limit until the person turns on going on by itself", async () => {
    const s = await started("limit plain");
    const resetsAt = Math.floor(Date.now() / 1000) - 600;
    feed(s.id, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } });
    feed(s.id, assistant([{ type: "text", text: "You've hit your session limit · resets 12:30am (Asia/Hong_Kong)" }], { error: "rate_limit" }));
    feed(s.id, result(true));
    expect(session(s.id)).toMatchObject({ status: "idle", wake: { limit: { resetsAt: new Date(resetsAt * 1000).toISOString(), autoContinue: false } } });
    await sleep(500);
    expect(agentTexts(s.id).some((t) => t.startsWith("MOCK: 额度已恢复"))).toBe(false);
    await runtime.setWakeChoice(s.id, { autoContinue: true });
    await until(() => agentTexts(s.id).includes(`MOCK: ${LIMIT_CONTINUE_TEXT}`) && session(s.id).status === "idle", "continuation");
    expect(session(s.id).wake).toBeUndefined();
    // The limit again (its reset time was off): the person's choice holds, but Studio does not go on again right away.
    feed(s.id, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } });
    feed(s.id, assistant([{ type: "text", text: "You've hit your session limit · resets 12:30am (Asia/Hong_Kong)" }], { error: "rate_limit" }));
    feed(s.id, result(true));
    expect(session(s.id).wake?.limit?.autoContinue).toBe(true);
    await sleep(500);
    expect(agentTexts(s.id).filter((t) => t === `MOCK: ${LIMIT_CONTINUE_TEXT}`)).toHaveLength(1);
  }, 120_000);

  it("an agent in the background asks between turns: once settled, the session is idle again, not left waiting (2026-10-16)", async () => {
    const s = await started("background ask");
    const live = internals().live.get(s.id);
    // Approved.
    const asked = internals().askPerson(s.id, live, "Bash", { command: "bash shot.sh" }, { signal: new AbortController().signal, toolUseID: "toolu_bg1" });
    expect(session(s.id).status).toBe("awaiting-approval");
    await runtime.respondApproval(s.id, "toolu_bg1", "accept");
    await asked;
    expect(session(s.id).status).toBe("idle");
    // Called off by the CLI.
    const off = new AbortController();
    void internals().askPerson(s.id, live, "Bash", { command: "bash other.sh" }, { signal: off.signal, toolUseID: "toolu_bg2" });
    expect(session(s.id).status).toBe("awaiting-approval");
    off.abort();
    expect(session(s.id).status).toBe("idle");
  }, 120_000);

  it("follows an agent resumed with SendMessage after the process that started it was closed", async () => {
    const s = await started("resume agent");
    // The agent's child session, made by an earlier process of this session (its Agent call is toolu_orig).
    const child = store.createSession({ taskId: task.id, topicId: null, parentId: s.id, kind: "sub", runtime: "claude", profileId: "claude-mock", workspaceId: workspace.id, title: "伤害统计", status: "completed", writer: "workbench", runtimeRef: `${s.runtimeRef}/agent/toolu_orig` });
    // The CLI's record of the agent ties its id to that call.
    const sub = join(claudeHome, "projects", "test-dir", s.runtimeRef!, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a142af.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "伤害统计", toolUseId: "toolu_orig" }));
    feed(s.id, assistant([{ type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: "a142af", summary: "resume", message: "继续 P5" } }]));
    expect(items(child.id).at(-1)).toMatchObject({ type: "user", text: "继续 P5" });
    feed(s.id, toolResult("toolu_send", "{\"success\":true}", { success: true, message: "Resuming agent a142af", resumedAgentId: "a142af" }));
    expect(session(child.id).status).toBe("running");
    feed(s.id, result());
    // The resumed agent runs in this process: the idle close leaves it alone.
    await sleep(900);
    expect(alive(s.id)).toBe(true);
    // Its messages carry the original Agent call.
    feed(s.id, { ...assistant([{ type: "text", text: "P5 做完了" }]), parent_tool_use_id: "toolu_orig" });
    expect(agentTexts(child.id)).toContain("P5 做完了");
    // Its notification names the SendMessage call.
    feed(s.id, { type: "system", subtype: "task_notification", task_id: "a142af", tool_use_id: "toolu_send", status: "completed", summary: "finished" });
    expect(session(child.id).status).toBe("completed");
  }, 120_000);
});
