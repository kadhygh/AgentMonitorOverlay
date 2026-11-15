import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WHITEBOARD_VIEW_MAX, splitRoleUpdate, type HostEvent, type ModelProfile, type Session, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store, newId } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { whiteboardHint } from "../../core/whiteboard.js";
import { DEFAULT_WHITEBOARD_VIEW } from "./template.js";

// 白板 (2026-11-16, plans/whiteboard.md): a session's working board — its AI writes the nodes and may give the page that
// draws them, the person pins notes that go to the AI with their next message.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let main: Session;
let events: HostEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-whiteboard-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const task = store.createTask({ title: "熔岩巨像", workspaceId: alpha.id });
  main = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "二阶段", status: "idle", writer: "workbench", runtimeRef: "thr-board" });
  events = [];
  service.on("event", (e: HostEvent) => events.push(e));
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const plan = () =>
  service.whiteboard.update(main.id, {
    set: [
      { id: "goal", kind: "goal", title: "二阶段：血量 50% 时换形态", group: "任务内容", status: "done" },
      { id: "a", kind: "suggestion", title: "方案 A：加一层阶段状态机", body: "改动集中在 BossController\n- 要动存档", group: "推进计划", after: ["goal"], status: "waiting" },
      { kind: "suggestion", title: "方案 B：叠 Buff", group: "推进计划", after: ["goal", "nowhere"] },
    ],
  });

describe("a session's board", () => {
  it("is empty and drawn by Studio's own page until its AI writes it", () => {
    const b = service.whiteboard.get(main.id);
    expect([b.on, b.rev, b.seenRev, b.nodes, b.notes]).toEqual([false, 0, 0, [], []]);
    expect(b.view).toEqual({ html: DEFAULT_WHITEBOARD_VIEW, own: false });
    // The page is what a template literal kept as written: its script has the calls the frame makes.
    expect(DEFAULT_WHITEBOARD_VIEW).toContain("window.renderBoard = function (board)");
    expect(DEFAULT_WHITEBOARD_VIEW).toContain('data-node="');
    expect(service.whiteboard.listOn()).toEqual([]);
  });

  it("takes the AI's nodes: its own ids or the next n…, changes by id, lines only to nodes that are there", () => {
    const first = plan();
    expect(first).toMatchObject({ rev: 1, added: [{ id: "goal" }, { id: "a" }, { id: "n1", title: "方案 B：叠 Buff" }], changed: [], removed: [] });
    const nodes = () => service.whiteboard.get(main.id).nodes;
    expect(nodes().map((n) => [n.id, n.kind, n.status, n.group, n.after, n.rev])).toEqual([
      ["goal", "goal", "done", "任务内容", [], 1],
      ["a", "suggestion", "waiting", "推进计划", ["goal"], 1],
      ["n1", "suggestion", "open", "推进计划", ["goal"], 1],
    ]);
    // Only the fields given change; the node says at which rev it last changed.
    expect(service.whiteboard.update(main.id, { set: [{ id: "n1", status: "dropped" }], remove: ["goal"] })).toMatchObject({ rev: 2, added: [], changed: ["n1"], removed: ["goal"] });
    expect(nodes().map((n) => [n.id, n.title, n.status, n.after, n.rev])).toEqual([
      ["a", "方案 A：加一层阶段状态机", "waiting", [], 1],
      ["n1", "方案 B：叠 Buff", "dropped", [], 2],
    ]);
    // What the AI reads back leaves out what is empty.
    expect(service.whiteboard.read(main.id)).toEqual({
      rev: 2,
      nodes: [
        { id: "a", kind: "suggestion", title: "方案 A：加一层阶段状态机", body: "改动集中在 BossController\n- 要动存档", status: "waiting", group: "推进计划" },
        { id: "n1", kind: "suggestion", title: "方案 B：叠 Buff", status: "dropped", group: "推进计划" },
      ],
      notes: [],
      view: "studio",
    });
    expect(events.filter((e) => e.type === "whiteboard.changed").at(-1)).toMatchObject({ type: "whiteboard.changed", sessionId: main.id, on: false, rev: 2 });
  });

  it("refuses what it cannot keep, with words the AI can act on", () => {
    expect(() => service.whiteboard.update(main.id, {})).toThrow(/至少一样/);
    expect(() => service.whiteboard.update(main.id, { set: [{ kind: "suggestion" }] })).toThrow(/新节点要有 title/);
    expect(() => service.whiteboard.update(main.id, { set: [{ title: "x", kind: "idea" }] })).toThrow(/kind 是这几种之一/);
    expect(() => service.whiteboard.update(main.id, { set: [{ title: "x", status: "later" }] })).toThrow(/status 是这几种之一/);
    expect(() => service.whiteboard.update(main.id, { set: [{ id: "有 空格", title: "x" }] })).toThrow(/节点 id/);
    expect(() => service.whiteboard.update(main.id, { replies: [{ note: "c9", text: "好" }] })).toThrow(/没有批注 c9/);
    expect(service.whiteboard.get(main.id).rev).toBe(0);
  });

  it("keeps the person's notes: on a node, beside one, at a place; rewritten only while not sent", () => {
    plan();
    service.whiteboard.addNote(main.id, { nodeId: "a", text: "  存档不能动，\n换个做法  " });
    service.whiteboard.addNote(main.id, { nodeId: "n1", x: 300.4, y: 12, quote: "叠 Buff", text: "这个会不会和冰冻冲突" });
    const b = service.whiteboard.addNote(main.id, { x: 640, y: 80, text: "这里加一栏风险" });
    expect(b.notes.map((n) => [n.id, n.nodeId, n.x, n.y, n.quote, n.text, n.state])).toEqual([
      ["c1", "a", undefined, undefined, undefined, "存档不能动，\n换个做法", "draft"],
      ["c2", "n1", 300, 12, "叠 Buff", "这个会不会和冰冻冲突", "draft"],
      ["c3", undefined, 640, 80, undefined, "这里加一栏风险", "draft"],
    ]);
    // A note changes nothing of the board's own content: the rev stays.
    expect(b.rev).toBe(1);
    expect(() => service.whiteboard.addNote(main.id, { text: "没有落点" })).toThrow(/落在一个节点上/);
    expect(() => service.whiteboard.addNote(main.id, { nodeId: "gone", text: "x" })).toThrow(/没有这个节点/);
    expect(() => service.whiteboard.addNote(main.id, { nodeId: "a", text: " " })).toThrow(/空的/);
    expect(service.whiteboard.editNote(main.id, "c3", { text: "这里加一栏「风险」" }).notes[2]!.text).toBe("这里加一栏「风险」");
    expect(service.whiteboard.removeNote(main.id, "c3").notes.map((n) => n.id)).toEqual(["c1", "c2"]);
  });

  it("tells its AI what the board is once, again after a compaction, and each note the person pinned since", () => {
    plan();
    service.whiteboard.addNote(main.id, { nodeId: "a", text: "存档不能动" });
    // Not a board the AI keeps yet: nothing is said, the note waits.
    expect(whiteboardHint(store, main.id).lines).toEqual([]);
    expect(service.whiteboard.set(main.id, { on: true }).on).toBe(true);
    expect(service.whiteboard.listOn()).toEqual([main.id]);
    const first = whiteboardHint(store, main.id);
    expect(first.lines).toHaveLength(3);
    expect(first.lines[0]).toContain("这个会话开了「白板」");
    expect(first.lines[1]).toContain("新写了 1 条批注");
    expect(first.lines[2]).toBe("· c1，在节点 a「方案 A：加一层阶段状态机」上：存档不能动");
    store.appendItem({ id: newId("item"), sessionId: main.id, createdAt: new Date().toISOString(), type: "user", text: "看一下" } as never);
    first.told();
    expect(service.whiteboard.get(main.id).notes[0]!.state).toBe("sent");
    expect(whiteboardHint(store, main.id).lines).toEqual([]);

    // A note beside a node says what is there; one at a place of the page only that.
    service.whiteboard.addNote(main.id, { nodeId: "n1", x: 300, y: 12, quote: "叠 Buff", text: "会不会和冰冻冲突" });
    service.whiteboard.addNote(main.id, { x: 640, y: 80, text: "加一栏风险" });
    const second = whiteboardHint(store, main.id);
    expect(second.lines).toEqual(["人在白板上新写了 2 条批注（用 whiteboard_update 的 replies 逐条回应，该改节点的改节点）：", "· c2，在节点 n1「方案 B：叠 Buff」旁边（那里的字：「叠 Buff」）：会不会和冰冻冲突", "· c3，在白板的一个位置上：加一栏风险"]);
    second.told();

    // After a compaction it has forgotten: it is sent to the board, not told the whole of it again.
    store.appendItem({ id: newId("item"), sessionId: main.id, createdAt: new Date().toISOString(), type: "compaction", state: "completed" } as never);
    const third = whiteboardHint(store, main.id);
    expect(third.lines).toHaveLength(1);
    expect(third.lines[0]).toContain("先调 whiteboard_read");
    store.appendItem({ id: newId("item"), sessionId: main.id, createdAt: new Date().toISOString(), type: "user", text: "继续" } as never);
    third.told();
    expect(whiteboardHint(store, main.id).lines).toEqual([]);

    // Off: said no more; on again: told again.
    service.whiteboard.set(main.id, { on: false });
    expect(service.whiteboard.listOn()).toEqual([]);
    expect(whiteboardHint(store, main.id).lines).toEqual([]);
    service.whiteboard.set(main.id, { on: true });
    expect(whiteboardHint(store, main.id).lines[0]).toContain("这个会话开了「白板」");
  });

  it("takes the AI's replies to notes, and the person closes a note or opens it again", () => {
    plan();
    service.whiteboard.addNote(main.id, { nodeId: "a", text: "存档不能动" });
    service.whiteboard.addNote(main.id, { nodeId: "n1", text: "先不做" });
    const done = service.whiteboard.update(main.id, { replies: [{ note: "c1", text: "改成只加内存里的状态，存档不动" }], set: [{ id: "a", body: "阶段状态只在内存里" }] });
    expect(done).toMatchObject({ rev: 2, changed: ["a"], replied: ["c1"] });
    // Both are still open to the AI: one answered, one it has said nothing to.
    expect(done.open.map((n) => [n.id, n.state, n.reply])).toEqual([["c1", "answered", "改成只加内存里的状态，存档不动"], ["c2", "draft", undefined]]);
    expect(() => service.whiteboard.editNote(main.id, "c1", { text: "改主意了" })).toThrow(/已经发给 AI 了/);
    expect(service.whiteboard.editNote(main.id, "c1", { closed: true }).notes[0]!.state).toBe("closed");
    expect(service.whiteboard.read(main.id).notes.map((n) => n.id)).toEqual(["c2"]);
    expect(service.whiteboard.editNote(main.id, "c1", { closed: false }).notes[0]!.state).toBe("answered");
    // Replies alone change no node: the rev stays, so nothing is marked as changed for the person.
    expect(service.whiteboard.update(main.id, { replies: [{ note: "c2", text: "好，标成不做了" }] }).rev).toBe(2);

    // A note on a node taken off stays, without its place, and says which node it was.
    service.whiteboard.update(main.id, { remove: ["n1"] });
    const note = service.whiteboard.get(main.id).notes[1]!;
    expect([note.nodeId, note.gone, note.text, note.state]).toEqual([undefined, "方案 B：叠 Buff", "先不做", "answered"]);
    expect(service.whiteboard.read(main.id).notes[1]!.where).toBe("在已经拿掉的节点「方案 B：叠 Buff」上");
  });

  it("marks what the person has not seen: a node's rev above the rev they last looked at", () => {
    plan();
    expect(service.whiteboard.get(main.id)).toMatchObject({ rev: 1, seenRev: 0 });
    expect(service.whiteboard.set(main.id, { seen: true })).toMatchObject({ rev: 1, seenRev: 1 });
    service.whiteboard.update(main.id, { set: [{ id: "a", status: "done" }] });
    const b = service.whiteboard.get(main.id);
    expect(b.nodes.filter((n) => n.rev > b.seenRev).map((n) => n.id)).toEqual(["a"]);
  });

  it("is drawn by the AI's own page once it gives one: whole, or by changing places of the present one", () => {
    // Nothing given: the page as it is, to change it.
    expect(service.whiteboard.view(main.id, {})).toEqual({ view: "studio", chars: DEFAULT_WHITEBOARD_VIEW.length, html: DEFAULT_WHITEBOARD_VIEW });
    // The quick way: a place of Studio's own page changed makes it the AI's.
    expect(service.whiteboard.view(main.id, { edits: [{ old: ".b-cols { display: flex; gap: 24px;", new: ".b-cols { display: flex; gap: 40px;" }] })).toEqual({ view: "yours", chars: DEFAULT_WHITEBOARD_VIEW.length });
    const b = service.whiteboard.get(main.id);
    expect(b.view.own).toBe(true);
    expect(b.view.html).toContain(".b-cols { display: flex; gap: 40px;");
    // The page changed: the board's rev says so, and the workbench draws it again.
    expect(b.rev).toBe(1);
    expect(service.whiteboard.read(main.id).view).toBe("yours");
    expect(() => service.whiteboard.view(main.id, { edits: [{ old: "不在页面里的字", new: "x" }] })).toThrow(/没找到这一段/);
    expect(() => service.whiteboard.view(main.id, { edits: [{ old: "var(--line)", new: "red" }] })).toThrow(/不止一处/);
    expect(() => service.whiteboard.view(main.id, { html: "x".repeat(WHITEBOARD_VIEW_MAX + 1) })).toThrow(/页面太长了/);
    expect(service.whiteboard.view(main.id, { html: "<div id=p></div><script>window.renderBoard = (b) => { p.textContent = b.nodes.length; };</script>" }).view).toBe("yours");
    expect(service.whiteboard.get(main.id).rev).toBe(2);
    expect(service.whiteboard.view(main.id, { reset: true })).toEqual({ view: "studio", chars: DEFAULT_WHITEBOARD_VIEW.length });
    expect(service.whiteboard.get(main.id).view).toEqual({ html: DEFAULT_WHITEBOARD_VIEW, own: false });
  });

  it("gives the session's AI its tools only while 白板 is turned on in 设置 → 测试功能", async () => {
    const names = () => amoToolsFor(service, { sessionId: main.id }).map((t) => t.name).filter((n) => n.startsWith("whiteboard_"));
    expect(names()).toEqual([]);
    service.config.updateSettings({ experimentalFeatures: ["whiteboard"] });
    expect(names()).toEqual(["whiteboard_read", "whiteboard_update", "whiteboard_view"]);
    const tool = (name: string) => amoToolsFor(service, { sessionId: main.id }).find((t) => t.name === name)!;
    const result = await tool("whiteboard_update").run({ set: [{ title: "先确认任务内容", kind: "plan" }] });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ rev: 1, added: [{ id: "n1", title: "先确认任务内容" }] });
    // A refusal reads as a tool error, not a protocol one.
    expect((await tool("whiteboard_update").run({ set: [{ kind: "plan" }] })).isError).toBe(true);
    expect(JSON.parse(((await tool("whiteboard_read").run({})).content[0] as { text: string }).text).nodes).toHaveLength(1);
  });

  it("sends the person's notes with their next message, and only while 白板 is on in the settings", async () => {
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(pred()).toBe(true);
    };
    const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));
    const live = await service.tasks.startSession({ taskId: main.taskId!, topicId: null }, alpha, { profileId: "p-ds", text: "开始" });
    const send = async (text: string) => {
      const before = userTexts(live.id).length;
      await service.sessions.sendMessage(live.id, text);
      await until(() => userTexts(live.id).length > before);
      return splitRoleUpdate(userTexts(live.id).at(-1)!);
    };
    service.whiteboard.update(live.id, { set: [{ id: "a", title: "方案 A" }] });
    service.whiteboard.set(live.id, { on: true });
    service.whiteboard.addNote(live.id, { nodeId: "a", text: "存档不能动" });
    // 测试功能 off: the message goes as written, the note waits.
    expect((await send("继续")).update).toBeNull();
    expect(service.whiteboard.get(live.id).notes[0]!.state).toBe("draft");
    service.config.updateSettings({ experimentalFeatures: ["whiteboard"] });
    events.length = 0;
    const sent = await send("看一下白板上的批注");
    expect(sent.text).toBe("看一下白板上的批注");
    expect(sent.update).toContain("这个会话开了「白板」");
    expect(sent.update).toContain("· c1，在节点 a「方案 A」上：存档不能动");
    expect(service.whiteboard.get(live.id).notes[0]!.state).toBe("sent");
    expect(events.some((e) => e.type === "whiteboard.changed" && e.sessionId === live.id)).toBe(true);
    expect((await send("再继续")).update).toBeNull();
  });
});
