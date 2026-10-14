import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Workspace } from "@amo-studio/protocol";
import { Store } from "../../store/store.js";
import { CodexRuntime, inputQuestions } from "./codex-runtime.js";
import { FakeServers } from "./fake-servers.test-support.js";

// Codex's request_user_input and MCP forms against the fake app-server (the real Codex 0.162 only offers
// request_user_input in Plan collaboration mode, which Studio does not start; the answer format below was checked
// against the real app-server with the mock model, see the S12-B report).

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let store: Store;
let servers: FakeServers;
let runtime: CodexRuntime;
let workspace: Workspace;
let taskId: string;

beforeEach(() => {
  store = new Store(":memory:");
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  workspace = store.addWorkspace({ path: "C:/sandbox/ws", name: "ws" });
  taskId = store.createTask({ title: "t", workspaceId: workspace.id }).id;
});

afterEach(async () => {
  await servers.close();
  store.close();
});

type QuestionItem = Extract<SessionItem, { type: "question" }>;
const until = async (pred: () => boolean, label = "condition", timeoutMs = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const items = (id: string) => store.listItems(id);
const question = (id: string) => items(id).find((i): i is QuestionItem => i.type === "question");
const lastAgent = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).at(-1)?.markdown ?? "";
const status = (id: string) => store.getSession(id)!.status;

describe("Codex questions", () => {
  it("answers request_user_input by question id, keeping the secret out of the item", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    const q = question(s.id)!;
    expect(q).toMatchObject({
      source: "codex-input",
      state: "pending",
      questions: [
        { id: "target", header: "目标环境", question: "要发布到哪个环境？", other: true, options: [{ label: "测试环境" }, { label: "正式环境" }] },
        { id: "token", question: "发布令牌是什么？", options: [], other: true, secret: true },
      ],
    });
    await runtime.answerQuestion(s.id, q.id, { action: "answer", answers: [{ id: "target", selected: [], other: "预发布环境" }, { id: "token", selected: [], other: "s3cret-value" }] });
    await until(() => lastAgent(s.id).startsWith("FAKE-ANSWERS") && status(s.id) === "idle", "the reply");
    expect(JSON.parse(lastAgent(s.id).slice("FAKE-ANSWERS: ".length))).toEqual({ answers: { target: { answers: ["预发布环境"] }, token: { answers: ["s3cret-value"] } } });
    const done = question(s.id)!;
    expect(done).toMatchObject({ state: "answered", answers: [{ id: "target", selected: [], other: "预发布环境" }, { id: "token", selected: [], other: "（已隐藏）" }] });
    // (The fake echoes the answers back in its reply; the question item itself never holds the secret.)
    expect(JSON.stringify(items(s.id).filter((i) => i.type === "question"))).not.toContain("s3cret-value");
    await expect(runtime.answerQuestion(s.id, q.id, { action: "dismiss" })).rejects.toThrow(/not pending/);
  });

  it("answers no questions when dismissed", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    await runtime.answerQuestion(s.id, question(s.id)!.id, { action: "dismiss" });
    await until(() => lastAgent(s.id).startsWith("FAKE-ANSWERS") && status(s.id) === "idle", "the reply");
    expect(lastAgent(s.id)).toBe('FAKE-ANSWERS: {"answers":{}}');
    expect(question(s.id)).toMatchObject({ state: "dismissed" });
  });

  it("cancels a pending question on interrupt", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    await runtime.interrupt(s.id);
    await until(() => status(s.id) === "idle", "idle");
    expect(question(s.id)).toMatchObject({ state: "cancelled" });
  });

  it("shows an MCP form's fields and returns the typed values as content", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[form]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    const q = question(s.id)!;
    expect(q).toMatchObject({ source: "mcp-form", message: "请填写发布信息", serverName: "amo" });
    expect(q.form!.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["version", "text", true],
      ["count", "integer", false],
      ["notify", "boolean", false],
      ["channel", "select", true],
      ["regions", "multi", false],
    ]);
    expect(items(s.id).some((i) => i.type === "approval")).toBe(false);
    await runtime.answerQuestion(s.id, q.id, { action: "submit", values: { version: "1.4.2", count: "20", notify: false, channel: "taptap", regions: ["cn"] } });
    await until(() => lastAgent(s.id).startsWith("FAKE-FORM") && status(s.id) === "idle", "the reply");
    expect(JSON.parse(lastAgent(s.id).slice("FAKE-FORM: ".length))).toEqual({ action: "accept", content: { version: "1.4.2", count: 20, notify: false, channel: "taptap", regions: ["cn"] }, _meta: null });
    expect(question(s.id)).toMatchObject({ state: "answered", values: { version: "1.4.2", count: 20 } });
  });

  it("declines an MCP form that is dismissed, and rejects values that do not fit", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[form]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    const q = question(s.id)!;
    await expect(runtime.answerQuestion(s.id, q.id, { action: "submit", values: { version: "1.0", channel: "nope" } })).rejects.toThrow(/渠道/);
    expect(question(s.id)).toMatchObject({ state: "pending" });
    await runtime.answerQuestion(s.id, q.id, { action: "dismiss" });
    await until(() => lastAgent(s.id).startsWith("FAKE-FORM") && status(s.id) === "idle", "the reply");
    expect(JSON.parse(lastAgent(s.id).slice("FAKE-FORM: ".length))).toEqual({ action: "decline", content: null, _meta: null });
    expect(question(s.id)).toMatchObject({ state: "dismissed" });
  });

  it("cancels questions a previous Host left pending", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    const again = new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES });
    expect(again).toBeTruthy();
    expect(question(s.id)).toMatchObject({ state: "cancelled" });
  });

  it("shows request_user_input_async as a question; the person's next message answers it", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask-async]]" });
    // The turn does not wait: it ends, and the open question leaves the person up.
    await until(() => lastAgent(s.id) === "FAKE-ASKED" && status(s.id) === "awaiting-answer", "the turn to end waiting for an answer");
    const q = question(s.id)!;
    expect(q).toMatchObject({ source: "codex-async", state: "pending", questions: [{ id: "q1", question: "你最喜欢哪个季节？", options: [{ label: "春天" }, { label: "夏天" }, { label: "秋天" }], other: true }] });
    // No plain-text copy of the question as an agent reply.
    expect(items(s.id).filter((i) => i.type === "agent").map((i) => (i as { markdown: string }).markdown)).toEqual(["FAKE-ASKED"]);
    // Answered on the card: the item keeps the answer (the sessions service then sends it as a message).
    await runtime.answerQuestion(s.id, q.id, { action: "answer", answers: [{ id: "q1", selected: ["夏天"] }] });
    expect(question(s.id)).toMatchObject({ state: "answered", answers: [{ id: "q1", selected: ["夏天"] }] });
    await runtime.sendMessage(s.id, "「你最喜欢哪个季节？」：夏天");
    await until(() => lastAgent(s.id) === "FAKE: 「你最喜欢哪个季节？」：夏天" && status(s.id) === "idle", "the reply to the answer");

    // Asked again and answered by typing instead: the message closes the question; the next Host keeps an open one.
    await runtime.sendMessage(s.id, "[[ask-async]]");
    await until(() => items(s.id).filter((i) => i.type === "question").length === 2 && status(s.id) === "awaiting-answer", "the second question");
    const again = new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES });
    expect(again).toBeTruthy();
    const second = items(s.id).filter((i): i is QuestionItem => i.type === "question")[1]!;
    expect(second.state).toBe("pending");
    await runtime.sendMessage(s.id, "冬天");
    expect(store.getItem(second.id)).toMatchObject({ state: "answered" });
    await until(() => status(s.id) === "idle", "idle");
  });

  it("dismissing an async question leaves the session idle", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[ask-async]]" });
    await until(() => status(s.id) === "awaiting-answer", "awaiting-answer");
    await runtime.answerQuestion(s.id, question(s.id)!.id, { action: "dismiss" });
    expect(question(s.id)).toMatchObject({ state: "dismissed" });
    expect(status(s.id)).toBe("idle");
  });

  it("an item Studio cannot read becomes a notice in its session; the turn goes on", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "[[bad-item]]" });
    await until(() => lastAgent(s.id) === "FAKE-AFTER-BAD" && status(s.id) === "idle", "the reply after the bad item");
    const notice = items(s.id).find((i): i is Extract<SessionItem, { type: "notice" }> => i.type === "notice");
    expect(notice?.message).toMatch(/Studio 处理 Codex 的一条消息（item\/completed）时出错/);
  });

  it("a turn the last Host saw running is closed as interrupted when the thread is idle", () => {
    const s = store.createSession({ taskId, topicId: null, parentId: null, kind: "main", profileId: "p-ds", runtime: "codex", workspaceId: workspace.id, title: "x", status: "idle", writer: "studio", runtimeRef: "t-gone" } as never);
    const turn = store.appendItem({ id: "i-turn", sessionId: s.id, createdAt: new Date().toISOString(), type: "turn", turnId: "u1", state: "running", startedAt: new Date().toISOString() } as never);
    const streaming = store.appendItem({ id: "i-agent", sessionId: s.id, createdAt: new Date().toISOString(), type: "agent", markdown: "半句", streaming: true } as never);
    expect(store.getSession(s.id)!.status).not.toBe("running");
    new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES });
    expect(store.getItem(turn.id)).toMatchObject({ state: "interrupted" });
    expect(store.getItem(streaming.id)).toMatchObject({ streaming: false });
  });

  it("reads request_user_input questions defensively", () => {
    expect(inputQuestions([{ id: "a", header: "H", question: "Q?", isOther: false, isSecret: false, options: [{ label: "x", description: "d" }] }, { question: "no id" }, null])).toEqual([
      { id: "a", header: "H", question: "Q?", options: [{ label: "x", description: "d" }] },
    ]);
    expect(inputQuestions(undefined)).toEqual([]);
  });
});
