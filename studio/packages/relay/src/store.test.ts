import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayError, RelayStore } from "./store.js";

let store: RelayStore;
afterEach(() => store?.close());

function team() {
  store = new RelayStore(":memory:");
  const a = store.register("策划小王", "pw-wang", "策划");
  const b = store.register("程序老李", "pw-li", "程序 · 战斗");
  return { a, b };
}

describe("RelayStore", () => {
  it("registers unique names, logs in with the password, one key per device", () => {
    const { a } = team();
    expect(store.memberByKey(a.key)).toBe("策划小王");
    expect(store.memberByKey("nope")).toBeNull();
    expect(() => store.register("策划小王", "whatever")).toThrow(RelayError);
    expect(() => store.register("a\nb", "whatever")).toThrow(/控制字符/);
    expect(() => store.register("新人", "123")).toThrow(/至少 4 位/);
    expect(store.members().map((m) => m.name)).toEqual(["策划小王", "程序老李"]);

    expect(() => store.login("策划小王", "wrong")).toThrow(/名字或密码不对/);
    expect(() => store.login("没这人", "pw-wang")).toThrow(/名字或密码不对/);
    const second = store.login("策划小王", "pw-wang");
    expect(second.key).not.toBe(a.key);
    expect(store.memberByKey(second.key)).toBe("策划小王");
    store.logout(second.key);
    expect(store.memberByKey(second.key)).toBeNull();
    expect(store.memberByKey(a.key)).toBe("策划小王");

    store.setPassword("策划小王", "new-pass");
    expect(store.memberByKey(a.key)).toBeNull();
    expect(store.login("策划小王", "new-pass").name).toBe("策划小王");
  });

  it("keeps one direct chat per pair and counts unread", () => {
    team();
    const t1 = store.direct("策划小王", "程序老李");
    const t2 = store.direct("程序老李", "策划小王");
    expect(t2.id).toBe(t1.id);
    expect(() => store.direct("策划小王", "策划小王")).toThrow(/自己/);
    expect(() => store.createRequest("策划小王", { to: "策划小王", title: "t", body: "b" })).toThrow(/用的就是 策划小王 本人的身份/);
    store.addMessage(t1.id, "策划小王", { body: "在吗" });
    store.addMessage(t1.id, "策划小王", { body: "看下这个" });
    const [li] = store.threadsFor("程序老李");
    expect(li?.unread).toBe(2);
    expect(li?.last?.body).toBe("看下这个");
    expect(store.threadsFor("策划小王")[0]?.unread).toBe(0);
    store.markRead(t1.id, "程序老李");
    expect(store.threadsFor("程序老李")[0]?.unread).toBe(0);
  });

  it("opens topics next to the direct chat; archiving is per person and a new message brings it back", () => {
    team();
    const direct = store.direct("策划小王", "程序老李");
    const topic = store.createTopic("策划小王", "程序老李", "技能表结构");
    expect(topic).toMatchObject({ kind: "topic", title: "技能表结构", members: ["策划小王", "程序老李"] });
    expect(store.createTopic("程序老李", "策划小王", "技能表结构").id).not.toBe(topic.id);
    expect(() => store.createTopic("策划小王", "程序老李", " ")).toThrow(/话题 不能为空/);
    expect(() => store.setArchived(direct.id, "策划小王", true)).toThrow(/普通聊天不能归档/);

    store.setArchived(topic.id, "策划小王", true);
    const archived = (who: string) => store.threadsFor(who).find((t) => t.id === topic.id)?.archived;
    expect(archived("策划小王")).toBe(true);
    expect(archived("程序老李")).toBe(false);
    store.addMessage(topic.id, "程序老李", { body: "表结构我改好了" });
    expect(archived("策划小王")).toBe(false);
    store.setArchived(topic.id, "策划小王", true);
    store.setArchived(topic.id, "策划小王", false);
    expect(archived("策划小王")).toBe(false);
  });

  it("adds the archived column to a database from before it", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-store-"));
    const file = join(dir, "relay.db");
    store = new RelayStore(file);
    store.register("策划小王", "pw-wang");
    store.register("程序老李", "pw-li");
    const t = store.direct("策划小王", "程序老李");
    store.db.exec("ALTER TABLE thread_members DROP COLUMN archived");
    store.close();
    store = new RelayStore(file);
    expect(store.threadsFor("策划小王").find((x) => x.id === t.id)?.archived).toBe(false);
    store.close();
    rmSync(dir, { recursive: true, force: true });
    store = new RelayStore(":memory:");
  });

  it("opens a request thread and takes a reply only from the person asked", () => {
    team();
    const { thread, message } = store.createRequest("策划小王", {
      to: "程序老李",
      title: "技能冷却能按等级变吗",
      body: "方案见下",
      questions: [{ text: "能做吗", options: ["能", "不能"] }, { id: "cost", text: "要几天" }],
      via: { kind: "ai", client: "claude-code" },
    });
    expect(thread.request).toMatchObject({ from: "策划小王", to: "程序老李", status: "open", requestSeq: message.seq });
    expect(message.questions?.map((q) => q.id)).toEqual(["q1", "cost"]);
    expect(message.via).toEqual({ kind: "ai", client: "claude-code" });

    expect(() => store.addMessage(thread.id, "策划小王", { kind: "reply", verdict: "agree" })).toThrow(/发给 程序老李/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "q1", choice: "也许" }] })).toThrow(/没有选项/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "zz", text: "x" }] })).toThrow(/没有这个问题/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply" })).toThrow(/空/);

    const out = store.addMessage(thread.id, "程序老李", {
      kind: "reply",
      body: "表要加一列",
      answers: [{ questionId: "q1", choice: "能" }, { questionId: "cost", text: "两天" }],
      verdict: "change",
    });
    expect(out.thread.request).toMatchObject({ status: "answered", verdict: "change" });
    expect(out.message.answers).toHaveLength(2);
    // A later follow-up without a verdict keeps the last one.
    const again = store.addMessage(thread.id, "程序老李", { kind: "reply", body: "补充：配置表在 skill.xlsx" });
    expect(again.thread.request?.verdict).toBe("change");
    expect(store.messages(thread.id, "策划小王").map((m) => m.kind)).toEqual(["request", "reply", "reply"]);
  });

  it("hands a session back and forth; only the asker closes one that needs a reply; the AI keeps out once its person took over", () => {
    team();
    const ai = { kind: "ai", client: "claude-code" } as const;
    const { thread } = store.createRequest("策划小王", { to: "程序老李", title: "射速", body: "见附件", questions: [{ text: "推进方式", options: ["主干", "分支"] }], via: ai });
    expect(thread.request).toMatchObject({ byAi: true, state: "open", waitingOn: "程序老李", handler: "ai", needsReply: true, returnedAt: null, pickedAt: null });
    // A person's own session may let the other close it.
    const loose = store.createRequest("策划小王", { to: "程序老李", title: "顺便", body: "看一眼", needsReply: false }).thread;
    expect(loose.request).toMatchObject({ handler: "person", needsReply: false });
    expect(store.sessionAction(loose.id, "程序老李", "done").thread.request).toMatchObject({ state: "done", waitingOn: null });

    expect(() => store.sessionAction(thread.id, "程序老李", "done")).toThrow(/只有发起方能标记完成/);
    expect(() => store.addMessage(thread.id, "策划小王", { body: "再问", pass: true })).toThrow(/在 程序老李 手里/);
    const back = store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "q1", choice: "分支" }], verdict: "agree" });
    expect(back.thread.request).toMatchObject({ state: "returned", waitingOn: "策划小王", status: "answered" });
    expect(back.thread.request?.returnedAt).toBeTypeOf("number");

    // The asker's AI fetches it: once.
    expect(store.markPicked(thread.id, "程序老李")).toBe(false);
    expect(store.markPicked(thread.id, "策划小王")).toBe(true);
    expect(store.markPicked(thread.id, "策划小王")).toBe(false);
    // 继续追问 hands it to the person asked again.
    const asked = store.addMessage(thread.id, "策划小王", { body: "分支名用什么", pass: true, via: ai });
    expect(asked.thread.request).toMatchObject({ state: "open", waitingOn: "程序老李" });
    // The person asked can also return it with a plain message.
    const plain = store.addMessage(thread.id, "程序老李", { body: "feature/gatling", pass: true });
    expect(plain.thread.request).toMatchObject({ state: "returned", waitingOn: "策划小王", pickedAt: null });

    // 我来处理: the person takes it from the AI; the AI is then refused, until 交还给 AI.
    expect(() => store.sessionAction(thread.id, "策划小王", "handle", { via: ai })).toThrow(/本人/);
    const taken = store.sessionAction(thread.id, "策划小王", "handle");
    expect(taken.thread.request?.handler).toBe("person");
    expect(taken.message).toMatchObject({ kind: "event", author: "策划小王", body: "从 AI 手里接手了这个会话" });
    expect(() => store.addMessage(thread.id, "策划小王", { body: "x", pass: true, via: ai })).toThrow(/本人接手/);
    expect(() => store.sessionAction(thread.id, "策划小王", "done", { via: ai })).toThrow(/本人接手/);
    store.sessionAction(thread.id, "策划小王", "toAi");
    // The AI hands it to its person with a note; then it closes it… after the person gives it back.
    expect(store.sessionAction(thread.id, "策划小王", "handoff", { via: ai, note: "要你定分支策略" }).message.body).toBe("AI 把会话交给本人处理：要你定分支策略");
    const done = store.sessionAction(thread.id, "策划小王", "done");
    expect(done.thread.request).toMatchObject({ state: "done", waitingOn: null });
    expect(() => store.sessionAction(thread.id, "策划小王", "done")).toThrow(/已经完成/);
    expect(store.sessionAction(thread.id, "程序老李", "reopen").thread.request).toMatchObject({ state: "open", waitingOn: "程序老李" });
  });

  it("turns the requests of a database from before sessions into sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-store-"));
    const file = join(dir, "relay.db");
    store = new RelayStore(file);
    store.register("策划小王", "pw-wang");
    store.register("程序老李", "pw-li");
    const open = store.createRequest("策划小王", { to: "程序老李", title: "还没回", body: "b", via: { kind: "ai" } }).thread;
    const answered = store.createRequest("策划小王", { to: "程序老李", title: "回了", body: "b" }).thread;
    store.addMessage(answered.id, "程序老李", { kind: "reply", verdict: "agree" });
    for (const c of ["s_state", "s_waiting", "s_handler", "s_needs", "s_returned", "s_picked"]) store.db.exec(`ALTER TABLE threads DROP COLUMN ${c}`);
    store.close();
    store = new RelayStore(file);
    const byId = new Map(store.threadsFor("策划小王").map((t) => [t.id, t.request]));
    expect(byId.get(open.id)).toMatchObject({ state: "open", waitingOn: "程序老李", handler: "ai", needsReply: true });
    expect(byId.get(answered.id)).toMatchObject({ state: "returned", waitingOn: "策划小王", handler: "person", needsReply: true });
    expect(byId.get(answered.id)?.returnedAt).toBeTypeOf("number");
    store.close();
    rmSync(dir, { recursive: true, force: true });
    store = new RelayStore(":memory:");
  });

  it("keeps team tasks: in someone's hands, handed over with a reason, seen, archived only when finished", () => {
    team();
    const t = store.createTask("策划小王", { title: "加特林", description: "按住连射" });
    expect(t).toMatchObject({ status: "开发中", holder: "策划小王", creator: "策划小王", archived: false, handoff: null, sessions: [] });
    expect(() => store.createTask("策划小王", { title: "x", status: "进行中" as never })).toThrow(/状态只能是/);
    expect(store.taskView(t.id, "程序老李").unseen).toBe(false);

    const moved = store.transferTask("策划小王", t.id, { to: "程序老李", status: "待处理", reason: "配置已提交主分支" });
    expect(moved).toMatchObject({ holder: "程序老李", status: "待处理", handoff: { from: "策划小王", to: "程序老李", reason: "配置已提交主分支" } });
    expect(store.taskView(t.id, "程序老李").unseen).toBe(true);
    expect(store.taskView(t.id, "策划小王").unseen).toBe(false);
    store.markTaskSeen(t.id, "程序老李");
    expect(store.taskView(t.id, "程序老李").unseen).toBe(false);
    // Taking it yourself is 接手 and nobody's news.
    store.transferTask("策划小王", t.id, { to: "策划小王", status: "开发中" });
    expect(store.taskView(t.id, "策划小王").unseen).toBe(false);

    expect(() => store.archiveTask("策划小王", t.id, true)).toThrow(/已完成或已搁置/);
    store.updateTask("程序老李", t.id, { status: "已完成", description: "按住连射，6 秒过热" });
    expect(store.archiveTask("程序老李", t.id, true).archived).toBe(true);
    expect(store.taskEvents(t.id).map((e) => e.text)).toEqual([
      "新建任务 · 开发中",
      "流转给 程序老李 · 待处理 · 原因：配置已提交主分支",
      "接手任务 · 开发中",
      "改了说明",
      "状态改为 已完成",
      "归档",
    ]);
    // Made for someone else: handed to them at once.
    const forLi = store.createTask("策划小王", { title: "新手引导", holder: "程序老李", status: "待处理" });
    expect(store.taskView(forLi.id, "程序老李").unseen).toBe(true);
    expect(store.tasksFor("程序老李").map((x) => x.title)).toEqual(["新手引导", "加特林"]);
  });

  it("puts sessions under a task: they show on it, their replies become its decisions", () => {
    team();
    const t = store.createTask("策划小王", { title: "加特林" });
    expect(() => store.createRequest("策划小王", { to: "程序老李", title: "x", body: "b", taskId: "k_none" })).toThrow(/没有这个任务/);
    const { thread } = store.createRequest("策划小王", { to: "程序老李", title: "射速", body: "见附件", taskId: t.id, questions: [{ text: "推进方式", options: ["主干", "分支"] }], via: { kind: "ai" } });
    expect(thread.request?.taskId).toBe(t.id);
    expect(store.task(t.id).sessions).toMatchObject([{ id: thread.id, title: "射速", state: "open", waitingOn: "程序老李", byAi: true }]);
    store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "q1", choice: "分支" }], verdict: "agree" });
    store.sessionAction(thread.id, "策划小王", "done");
    const events = store.taskEvents(t.id);
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["created", "新建任务 · 开发中"],
      ["session", "的 AI 发起会话「射速」→ 程序老李"],
      ["decision", "推进方式：分支；结论：同意（来自会话「射速」）"],
      ["session", "会话「射速」标记完成"],
    ]);
    expect(store.task(t.id).sessions[0]?.state).toBe("done");
  });

  it("keeps files by version, a session's for its two people only, and notes across versions", () => {
    team();
    store.register("美术小张", "pw-zhang");
    const t = store.createTask("策划小王", { title: "加特林" });
    const meta = (id: string, extra: Partial<{ taskId: string; threadId: string }>) => ({ id, name: "designdoc.md", size: 10, type: "text/markdown", sha256: "x", ...extra });
    const v1 = store.addFile("策划小王", meta("f_1", { taskId: t.id }));
    const v2 = store.addFile("程序老李", meta("f_2", { taskId: t.id }));
    expect([v1.version, v2.version, v2.versions]).toEqual([1, 2, 2]);
    expect(store.task(t.id).files.map((f) => f.id)).toEqual(["f_2"]);
    expect(store.taskEvents(t.id).filter((e) => e.kind === "file").map((e) => e.text)).toEqual(["上传 designdoc.md v1", "上传 designdoc.md v2"]);
    expect(() => store.addFile("策划小王", { id: "f_x", name: "a", size: 1, sha256: "x" })).toThrow(/一个任务或一个会话/);

    // A session takes the task's file along and gets one of its own; outsiders see neither of the session's.
    const { thread } = store.createRequest("策划小王", { to: "程序老李", title: "射速", body: "见附件", taskId: t.id, files: ["f_2"] });
    store.addFile("程序老李", { id: "f_3", threadId: thread.id, name: "proto.html", size: 5, type: "text/html", sha256: "y" });
    expect(store.filesOf({ threadId: thread.id }, "策划小王").map((f) => f.id)).toEqual(["f_2", "f_3"]);
    expect(() => store.file("f_3", "美术小张")).toThrow(/不在这个对话/);
    expect(store.file("f_2", "美术小张").name).toBe("designdoc.md");

    // Notes on v1 and v2 all come back for either version; only the author removes one.
    const n1 = store.addNote("程序老李", "f_1", { quote: "每秒 12 发", prefix: "基础射速 ", suffix: "，按住", body: "配表？" });
    const n2 = store.addNote("程序老李", "f_2", { quote: "6 秒进入过热", body: "复用能量条" });
    expect(store.notesOf("f_2", "策划小王").map((n) => [n.id, n.version])).toEqual([[n1.id, 1], [n2.id, 2]]);
    expect(store.file("f_2", "策划小王").notes).toBe(1);
    expect(() => store.deleteNote("策划小王", n2.id)).toThrow(/自己的批注/);

    // A reply can be just notes; they are copied in.
    const reply = store.addMessage(thread.id, "程序老李", { kind: "reply", notes: [n1.id, n2.id] });
    expect(reply.message.notes).toMatchObject([{ file: "designdoc.md", version: 1, quote: "每秒 12 发", body: "配表？" }, { version: 2, body: "复用能量条" }]);
    store.deleteNote("程序老李", n1.id);
    expect(store.messages(thread.id, "策划小王").at(-1)?.notes).toHaveLength(2);
  });

  it("keeps the team's settings, defaults first", () => {
    team();
    expect(store.settings().keywords).toContain("程序接手开发");
    const s = store.saveSettings({ flow: "先对需求再开发", aiLateMinutes: 5 });
    expect(s).toMatchObject({ flow: "先对需求再开发", aiLateMinutes: 5, aiStuckMinutes: 30 });
    expect(() => store.saveSettings({ aiStuckMinutes: 0 })).toThrow(/1 到 1440/);
  });

  it("keeps people out of threads they are not in", () => {
    team();
    store.register("美术小张", "pw-zhang");
    const { thread } = store.createRequest("策划小王", { to: "程序老李", title: "t", body: "b" });
    expect(() => store.messages(thread.id, "美术小张")).toThrow(/不在这个对话/);
    expect(() => store.addMessage(thread.id, "美术小张", { body: "hi" })).toThrow(/不在这个对话/);
    expect(store.threadsFor("美术小张")).toEqual([]);
    expect(() => store.createRequest("策划小王", { to: "没这人", title: "t", body: "b" })).toThrow(/没有这个人/);
  });
});
