import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_ASK_QUESTIONS, MOCK_CLAUDE_MODEL, MOCK_PLAN, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { ClaudeRuntime } from "./claude-runtime.js";

// Claude's questions (AskUserQuestion) and plan reviews (ExitPlanMode) through the real Claude Agent SDK against the
// mock Anthropic API: what the person answers is what the model reads in the tool result. No model budget.

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];
let root: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;

type QuestionItem = Extract<SessionItem, { type: "question" }>;
const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const items = (id: string) => store.listItems(id);
const question = (id: string) => items(id).find((i): i is QuestionItem => i.type === "question");
const lastAgent = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).at(-1)?.markdown ?? "";
const status = (id: string) => store.getSession(id)!.status;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-questions-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  runtime = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: { baseUrl: mock.baseUrl } }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome: join(root, "claude-home") });
  workspace = store.addWorkspace({ path: join(root, "workspace"), name: "ws" });
  task = store.createTask({ title: "questions", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("Claude questions", () => {
  it("shows AskUserQuestion as a question and hands the answers to the model", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[ask]] 加上重试" });
    await until(() => status(s.id) === "awaiting-answer", "the question");
    const q = question(s.id)!;
    expect(q).toMatchObject({ source: "claude-ask", state: "pending" });
    expect(q.questions!.map((x) => [x.id, x.multiSelect ?? false, x.options.length])).toEqual(MOCK_ASK_QUESTIONS.map((x) => [x.question, x.multiSelect, 3]));
    // No approval card and no tool row stand for the call.
    expect(items(s.id).some((i) => i.type === "approval" || i.type === "tool")).toBe(false);

    const [first, second] = MOCK_ASK_QUESTIONS;
    await runtime.answerQuestion(s.id, q.id, {
      action: "answer",
      answers: [
        { id: first!.question, selected: ["固定间隔"] },
        { id: second!.question, selected: ["失败原因", "等待时长"], other: "还有请求的 URL" },
      ],
    });
    await until(() => lastAgent(s.id).startsWith("MOCK-ANSWERED") && status(s.id) === "idle", "the reply");
    const reply = lastAgent(s.id);
    expect(reply).toContain(`"${first!.question}"="固定间隔"`);
    expect(reply).toContain(`"${second!.question}"="失败原因, 等待时长, 还有请求的 URL"`);
    expect(question(s.id)).toMatchObject({ state: "answered", answers: [{ id: first!.question, selected: ["固定间隔"] }, { id: second!.question, selected: ["失败原因", "等待时长"], other: "还有请求的 URL" }] });
  }, 120_000);

  it("tells the model the person did not answer when the questions are dismissed", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[ask]] 第二次" });
    await until(() => status(s.id) === "awaiting-answer", "the question");
    await runtime.answerQuestion(s.id, question(s.id)!.id, { action: "dismiss" });
    await until(() => lastAgent(s.id).startsWith("MOCK-ANSWERED") && status(s.id) === "idle", "the reply");
    expect(lastAgent(s.id)).toContain("closed these questions in AMO Studio without answering");
    expect(question(s.id)).toMatchObject({ state: "dismissed" });
  }, 120_000);

  it("cancels a pending question on interrupt", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[ask]] 打断" });
    await until(() => status(s.id) === "awaiting-answer", "the question");
    await runtime.interrupt(s.id);
    await until(() => status(s.id) === "idle", "idle after the interrupt");
    expect(question(s.id)).toMatchObject({ state: "cancelled" });
    await expect(runtime.answerQuestion(s.id, question(s.id)!.id, { action: "dismiss" })).rejects.toThrow(/not pending/);
  }, 120_000);

  it("reviews a plan: changes asked for go back to the model, approval leaves plan mode", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[plan]] 先计划", options: { permission: "plan" } });
    await until(() => status(s.id) === "awaiting-answer", "the plan review");
    const review = question(s.id)!;
    expect(review).toMatchObject({ source: "plan-review", state: "pending", plan: MOCK_PLAN });
    await runtime.answerQuestion(s.id, review.id, { action: "revise", feedback: "测试也要覆盖超时" });
    await until(() => lastAgent(s.id).startsWith("MOCK-PLAN") && status(s.id) === "idle", "the reply to the revision");
    expect(lastAgent(s.id)).toContain("测试也要覆盖超时");
    expect(question(s.id)).toMatchObject({ state: "answered", feedback: "测试也要覆盖超时" });
    expect(store.getSession(s.id)!.options.permission).toBe("plan");

    await runtime.sendMessage(s.id, "[[plan]] 再来一次");
    await until(() => items(s.id).filter((i) => i.type === "question").length === 2 && status(s.id) === "awaiting-answer", "the second review");
    const again = items(s.id).filter((i): i is QuestionItem => i.type === "question").at(-1)!;
    await runtime.answerQuestion(s.id, again.id, { action: "approve" });
    await until(() => status(s.id) === "idle" && lastAgent(s.id).includes("approved"), "the reply to the approval");
    expect(store.getSession(s.id)!.options.permission).toBe("default");
    expect(items(s.id).filter((i) => i.type === "question").at(-1)).toMatchObject({ state: "answered" });
  }, 180_000);
});
