import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasItem, HostEvent, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";

// 画布审阅 (2026-10-27): items laid out on a topic's canvas, bubbles on its cards, the person's answers back to the
// asking session, and a session to talk one item over.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let task: Task;
let caller: Session;
let events: HostEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-review-canvas-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = store.createTopic({ title: "relay 审阅" });
  task = store.createTask({ title: "主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  caller = await service.tasks.addSession(task.id, { profileId: "p-ds" });
  await service.sessions.renameSession(caller.id, "主会话");
  events = [];
  service.on("event", (e) => events.push(e));
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));
const items = () => service.canvases.canvas(topic.id).nodes.filter((n): n is CanvasItem => n.kind === "item");
const tool = (name: string) => amoToolsFor(service, { sessionId: caller.id }).find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>) => {
  const out = await tool(name).run(args);
  if (out.isError) throw new Error(out.content[0]!.text);
  return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
};

describe("画布审阅", () => {
  it("lays items out in a new group, numbers on, and adds to that group by its title", async () => {
    const first = await run("canvas_items_post", { group: "本周提交", items: [{ title: "协议改了", body: "客户端要一起升", refs: ["abc123"] }, { title: "重连" }] });
    expect(first.items).toMatchObject([{ num: 1, title: "协议改了" }, { num: 2, title: "重连" }]);
    const doc = service.canvases.canvas(topic.id);
    expect(doc.groups).toMatchObject([{ id: first.groupId, title: "本周提交" }]);
    expect(items().map((i) => [i.num, i.status, i.sessionId, i.groupId])).toEqual([
      [1, "todo", caller.id, first.groupId],
      [2, "todo", caller.id, first.groupId],
    ]);
    // Inside the group, side by side, not overlapping.
    const g = doc.groups[0]!.rect;
    for (const i of items()) expect(i.pos.x >= g.x && i.pos.y >= g.y && i.pos.x + 240 <= g.x + g.w && i.pos.y + 124 <= g.y + g.h).toBe(true);
    const more = await run("canvas_items_post", { group: "本周提交", items: [{ title: "日志", status: "confirmed" }] });
    expect(more).toMatchObject({ groupId: first.groupId, items: [{ num: 3 }] });
    expect(service.canvases.canvas(topic.id).groups).toHaveLength(1);
    expect(tool("canvas_items_post").autoApprove).toBe(true);
    await expect(run("canvas_items_post", { items: [{ title: "x", status: "maybe" }] })).rejects.toThrow(/status/);
    await expect(run("canvas_items_post", { items: [] })).rejects.toThrow(/non-empty/);
  });

  it("updates an item by #n, and canvas_read lists items, bubbles and answers", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }, { title: "重连" }] });
    const updated = await run("canvas_item_update", { item: "#2", status: "confirmed", conclusion: "保持现状" });
    expect(updated).toMatchObject({ num: 2, status: "confirmed", conclusion: "保持现状" });
    await expect(run("canvas_item_update", { item: "#9", status: "done" })).rejects.toThrow(/no review item/);
    await run("canvas_callout", { target: "#1", kind: "question", text: "要不要兼容旧客户端？", options: ["兼容", "不兼容"] });
    const read = await tool("canvas_read").run({});
    const outline = read.content[0]!.text;
    expect(outline).toContain("#1【待看】协议改了");
    expect(outline).toContain("#2【已确认】重连");
    expect(outline).toContain("结论：保持现状");
    expect(outline).toContain("问题（等人回答） · 你写的");
    const json = JSON.parse(read.content[1]!.text);
    expect(json.groups[0].items.map((i: { num: number }) => i.num)).toEqual([1, 2]);
    expect(json.callouts).toMatchObject([{ kind: "question", state: "open", mine: true, on: "#1「协议改了」" }]);
  });

  it("pins bubbles to items, task cards, notes and groups, and refuses what is not on the canvas", async () => {
    const { groupId } = await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }] });
    service.canvases.setTaskOnCanvas(task.id, { onCanvas: true });
    const onItem = await run("canvas_callout", { target: "1", text: "客户端要一起升" });
    expect(onItem).toMatchObject({ kind: "note", state: "open", target: items()[0]!.id, sessionId: caller.id });
    expect((await run("canvas_callout", { target: task.id, kind: "question", text: "先做哪个？", deep: true })).deep).toBe(true);
    expect((await run("canvas_callout", { target: String(groupId), text: "整组先看" })).target).toBe(groupId);
    await expect(run("canvas_callout", { target: "nope", text: "x" })).rejects.toThrow(/nothing on this canvas/);
    await expect(run("canvas_callout", { target: "#1", text: "x", options: ["a"] })).rejects.toThrow(/options are for a question/);
    expect(service.canvasReview.callouts(topic.id)).toHaveLength(3);
    expect(events.filter((e) => e.type === "callout.upserted")).toHaveLength(3);
  });

  it("sends the person's answer to the asking session, keeps it, and the agent closes the bubble", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }] });
    const q = await run("canvas_callout", { target: "#1", kind: "question", text: "要不要兼容旧客户端？" });
    await run("canvas_callout", { target: "#1", text: "只是说明，不算在等的问题里" });
    expect(store.waitingQuestions()).toEqual({ [topic.id]: 1 });
    const answered = await service.canvasReview.answer(String(q.id), { text: "兼容一个版本" });
    expect(store.waitingQuestions()).toEqual({});
    expect(answered).toMatchObject({ state: "answered", answer: { text: "兼容一个版本" } });
    expect(answered.answer!.sent).not.toBe("none");
    await until(() => userTexts(caller.id).some((t) => t.includes("【画布回答】")));
    const message = userTexts(caller.id).find((t) => t.includes("【画布回答】"))!;
    expect(message).toContain("#1「协议改了」");
    expect(message).toContain("你写的：要不要兼容旧客户端？");
    expect(message).toContain("人的回答：兼容一个版本");
    expect(message).toContain(`canvas_callout_close（calloutId: ${String(q.id)}）`);
    expect(await run("canvas_callout_close", { calloutId: q.id })).toEqual({ closed: [q.id] });
    expect(service.canvasReview.getCallout(String(q.id)).state).toBe("closed");
    // Closed ones stay listed for the page, but not in canvas_read.
    expect(service.canvasReview.callouts(topic.id).map((c) => c.state)).toEqual(["open", "closed"]);
    expect(service.canvases.canvasOutline(topic.id).json.callouts.map((c) => c.kind)).toEqual(["note"]);
    await expect(service.canvasReview.answer(String(q.id), { text: "再说" })).rejects.toThrow(/closed/);
  });

  it("an answer to a gone session is kept, not sent; closing by target closes every bubble on that card", async () => {
    await run("canvas_items_post", { items: [{ title: "协议改了" }] });
    const q = await run("canvas_callout", { target: "#1", kind: "question", text: "兼容？" });
    await run("canvas_callout", { target: "#1", text: "注意" });
    await service.sessions.archive(caller.id);
    expect((await service.canvasReview.answer(String(q.id), { text: "兼容" })).answer).toMatchObject({ text: "兼容", sent: "none" });
    expect(service.canvasReview.closeFor(topic.id, { target: "#1" }).closed).toHaveLength(2);
  });

  it("就这条展开聊: a session in the laying session's task, seeded with the item, listed on it", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了", body: "客户端要一起升", refs: ["packages/relay/src/protocol.ts"] }] });
    const item = items()[0]!;
    const session = await service.canvasReview.discuss(topic.id, "#1", {});
    expect(session).toMatchObject({ taskId: task.id, profileId: "p-ds", title: "#1 协议改了" });
    expect(store.getSession(session.id)?.startedBy ?? null).toBeNull();
    expect(items()[0]!.threads).toEqual([session.id]);
    await until(() => userTexts(session.id).length > 0);
    const first = userTexts(session.id)[0]!;
    expect(first).toContain("【就这条展开聊】");
    expect(first).toContain("客户端要一起升");
    expect(first).toContain("packages/relay/src/protocol.ts");
    expect(first).toContain(`canvas_item_update（item: "#1"）`);
    expect(first).toContain(`mailbox_send 给会话 ${caller.id}`);
    await expect(service.canvasReview.discuss(topic.id, item.id + "x", {})).rejects.toThrow(/no review item/);
  });
});
