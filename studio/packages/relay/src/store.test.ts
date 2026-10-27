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
    expect(thread.request).toMatchObject({ state: "open", waitingOn: "程序老李", handler: "ai", needsReply: true, returnedAt: null, pickedAt: null });
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
