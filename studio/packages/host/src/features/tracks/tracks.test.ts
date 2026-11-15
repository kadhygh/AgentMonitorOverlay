import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store, newId } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { tracksHint } from "../../core/tracks.js";
import { letter } from "./tower.js";

// 脉络的楼 (2026-11-15): a session's rows as a building — rounds as floors, the sessions it started as regions, what
// came back as small cards, what waits on the roof — and what its AI adds with track_note.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let service: HostService;
let alpha: Workspace;
let main: Session;
let events: HostEvent[];

const session = (taskId: string, extra: Partial<Session> = {}) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${Math.random()}`, ...extra });
// Rows a second apart, a little ahead of the clock: every session made meanwhile was made "before round 2".
let tick = Date.now();
const row = (s: Session, body: Record<string, unknown>) => store.appendItem({ id: newId("item"), sessionId: s.id, createdAt: new Date((tick += 1000)).toISOString(), ...body } as never);
const user = (s: Session, text: string, extra: Record<string, unknown> = {}) => row(s, { type: "user", text, ...extra });
const agent = (s: Session, markdown: string) => row(s, { type: "agent", markdown, streaming: false });
const tool = (s: Session, name: string, summary: string, input?: string) => row(s, { type: "tool", name, summary, status: "completed", ...(input ? { input } : {}) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-tracks-"));
  store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const task = store.createTask({ title: "熔岩巨像", workspaceId: alpha.id });
  main = session(task.id, { title: "二阶段" });
  events = [];
  service.on("event", (e: HostEvent) => events.push(e));
});

afterEach(() => {
  store.close();
  removeTempDir(root);
});

describe("the building of a session", () => {
  it("cuts the rows into rounds: a message begins one once the round before did something", () => {
    user(main, "先看 Boss 的代码怎么组织。\n要细一点");
    tool(main, "Read", "读 BossController.cs");
    agent(main, "Boss 用一个状态机。血量有事件可以挂。");
    user(main, "给个方案");
    user(main, "要两个");
    agent(main, "A 加阶段层；B 叠 Buff。");
    const t = service.tracks.get(main.id);
    expect(t.rounds.map((r) => [r.n, r.title, r.desc, r.labelled])).toEqual([
      [1, "先看 Boss 的代码怎么组织。", "Boss 用一个状态机", false],
      [2, "给个方案", "A 加阶段层", false],
    ]);
    expect(t.rounds[0]!.work).toEqual(["读 BossController.cs"]);
    // Two messages before any work are one round's.
    expect(t.rounds[1]!.you).toBe("给个方案\n\n要两个");
    expect(t.on).toBe(false);
    expect(t.roof).toEqual([]);
  });

  it("leaves out what is held in the inbox, and reads who a message is from", () => {
    user(main, "开始");
    agent(main, "好");
    user(main, "【你开的会话「特效」（s-x）这一轮做完了】\n首次喷发卡 18ms", { delivery: "held" });
    expect(service.tracks.get(main.id).rounds).toHaveLength(1);
  });

  it("shows the sessions it started as regions, their reports as cards on the floor they came to, and what is not over on the roof", () => {
    user(main, "拆开并行做");
    tool(main, "session_start", "开子会话");
    agent(main, "开了两个子会话。");
    const a = session(main.taskId!, { title: "特效性能", status: "idle" });
    store.setSessionStartedBy(a.id, main.id);
    user(a, "【由本任务的会话「二阶段」开启】\n测喷发特效的性能");
    agent(a, "首次实例化 18ms。");
    const b = session(main.taskId!, { title: "存档兼容", status: "running" });
    store.setSessionStartedBy(b.id, main.id);
    user(b, "【由本任务的会话「二阶段」开启】\n查存档");
    user(main, "接着写技能");
    agent(main, "写好了。");
    user(main, "【你开的会话「特效性能」（" + a.id + "）这一轮做完了】\n首次喷发卡 18ms，建议预热", { origin: { kind: "report", from: "特效性能", sessionId: a.id, state: "done" } });
    agent(main, "收到，加预热。");

    const t = service.tracks.get(main.id);
    expect(t.sessions.map((s) => [s.key, s.title, s.at, s.total, s.state.s])).toEqual([
      ["A", "特效性能", 1, 1, "done"],
      ["B", "存档兼容", 1, 1, "ai"],
    ]);
    expect(t.rounds.map((r) => r.title)).toEqual(["拆开并行做", "接着写技能", "子会话「特效性能」回报"]);
    expect(t.rounds[0]!.items).toEqual([{ s: "ai", t: "开了子会话 A、B" }]);
    expect(t.reports).toMatchObject([{ from: "A-1", sess: "A", round: 1, floor: 3, title: "A 回报", desc: "首次喷发卡 18ms，建议预热" }]);
    // B still runs: a card on the roof, from its latest round.
    expect(t.roof).toMatchObject([{ key: "roof:B", s: "ai", origin: "B-1", sessionId: b.id }]);
  });

  it("puts a pending approval on the roof with a sign", () => {
    user(main, "提交这批改动");
    row(main, { type: "approval", approvalId: "ap1", kind: "command", summary: "git commit -m x", state: "pending" });
    const t = service.tracks.get(main.id);
    expect(t.roof).toMatchObject([{ s: "you", origin: "m1", title: "等你审批：git commit -m x", sign: "待你审批" }]);
    expect(t.rounds[0]!.items).toEqual([{ s: "you", t: "等你审批：git commit -m x" }]);
  });

  it("names sub-sessions A … Z, AA …", () => {
    expect([0, 1, 25, 26, 27, 52].map(letter)).toEqual(["A", "B", "Z", "AA", "AB", "BA"]);
  });
});

describe("脉络会话", () => {
  it("is turned on per session, listed, and told to its AI once (again after a compaction)", () => {
    user(main, "开始");
    agent(main, "好");
    expect(tracksHint(store, main.id).lines).toEqual([]);
    expect(service.tracks.setOn(main.id, true).on).toBe(true);
    expect(service.tracks.listOn()).toEqual([main.id]);
    expect(events.filter((e) => e.type === "tracks.changed")).toMatchObject([{ sessionId: main.id, on: true }]);

    const hint = tracksHint(store, main.id);
    expect(hint.lines.join("")).toContain("track_note");
    user(main, "下一步");
    hint.told();
    expect(tracksHint(store, main.id).lines).toEqual([]);
    row(main, { type: "compaction", state: "completed" });
    expect(tracksHint(store, main.id).lines).toHaveLength(1);

    service.tracks.setOn(main.id, false);
    expect(service.tracks.listOn()).toEqual([]);
    expect(tracksHint(store, main.id).lines).toEqual([]);
  });

  it("takes its AI's title for the latest round, and the points it notes", () => {
    user(main, "先用占位值，我去问策划。数值一定按策划表来");
    agent(main, "阶段切换写好了。");
    const said = service.tracks.note(main.id, { title: "写阶段切换和攻速", desc: "过 50% 切二阶段，攻速 ×1.3", points: ["数值按策划表来", "数值按策划表来"] });
    expect(said).toEqual({ floor: 1, title: "写阶段切换和攻速", desc: "过 50% 切二阶段，攻速 ×1.3", open: [{ id: "p1", text: "数值按策划表来" }] });
    let t = service.tracks.get(main.id);
    expect(t.rounds[0]).toMatchObject({ title: "写阶段切换和攻速", desc: "过 50% 切二阶段，攻速 ×1.3", labelled: true });
    expect(t.points).toMatchObject([{ id: "p1", text: "数值按策划表来", round: 1 }]);

    user(main, "策划回了");
    agent(main, "进表了。");
    expect(service.tracks.note(main.id, { title: "填进策划的数值", done: ["p1"] })).toMatchObject({ floor: 2, open: [] });
    t = service.tracks.get(main.id);
    expect(t.rounds.map((r) => [r.title, r.labelled])).toEqual([["写阶段切换和攻速", true], ["填进策划的数值", true]]);
    expect(t.points[0]!.done).toBe(true);
    expect(() => service.tracks.note(main.id, {})).toThrow(/至少一样/);
  });

  it("offers track_note only while 脉络 is on in 测试功能", () => {
    const names = () => amoToolsFor(service, { sessionId: main.id }).map((t) => t.name);
    expect(names()).not.toContain("track_note");
    service.config.updateSettings({ experimentalFeatures: ["tracks"] });
    expect(names()).toContain("track_note");
  });
});
