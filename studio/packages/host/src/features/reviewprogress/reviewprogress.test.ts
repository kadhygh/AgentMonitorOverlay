import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session, SessionItem, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store, newId } from "../../store/store.js";

// 审阅进度 (第二版 2026-11-16): how far the person read each reply of a session, block by block, and the blocks they
// marked 「!」 — kept by the Host by the reply's row id, only what the person clicked.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let service: HostService;
let alpha: Workspace;
let main: Session;
let events: HostEvent[];

const session = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${Math.random()}` });
const row = (s: Session, body: Record<string, unknown>): SessionItem => store.appendItem({ id: newId("item"), sessionId: s.id, createdAt: new Date().toISOString(), ...body } as never);
const agent = (s: Session, markdown: string) => row(s, { type: "agent", markdown, streaming: false }).id;
const user = (s: Session, text: string) => row(s, { type: "user", text }).id;
const changes = () => events.filter((e) => e.type === "reviewprogress.changed");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-review-progress-"));
  store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  main = session(store.createTask({ title: "熔岩巨像", workspaceId: alpha.id }).id);
  service.config.updateSettings({ experimentalFeatures: ["review-progress"] });
  events = [];
  service.on("event", (e: HostEvent) => events.push(e));
});

afterEach(() => {
  store.close();
  removeTempDir(root);
});

describe("审阅进度", () => {
  it("starts with nothing, records how far a reply was read, moves it and takes it back, and says so once per change", () => {
    const a = agent(main, "第一条");
    expect(service.reviewProgress.get(main.id)).toEqual({ sessionId: main.id, replies: {} });
    expect(service.reviewProgress.update(main.id, { read: { id: a, blocks: 2, of: 5, at: "第二段" } }).replies).toEqual({ [a]: { read: 2, of: 5, at: "第二段", flags: [] } });
    expect(service.reviewProgress.update(main.id, { read: { id: a, blocks: 4, of: 5, at: "第四段" } }).replies[a]).toEqual({ read: 4, of: 5, at: "第四段", flags: [] });
    // The same again changes nothing and says nothing.
    service.reviewProgress.update(main.id, { read: { id: a, blocks: 4, of: 5, at: "第四段" } });
    expect(changes()).toHaveLength(2);
    expect(changes().at(-1)).toMatchObject({ sessionId: main.id, replies: { [a]: { read: 4 } } });
    // Taken back (read 0) with no 「!」: nothing left of it.
    expect(service.reviewProgress.update(main.id, { read: { id: a, blocks: 0, of: 5 } }).replies).toEqual({});
    // Kept: a new Host on the same store reads it back.
    service.reviewProgress.update(main.id, { read: { id: a, blocks: 1, of: 5, at: "第一段" } });
    expect(new HostService(store, new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") }).reviewProgress.get(main.id).replies).toEqual({ [a]: { read: 1, of: 5, at: "第一段", flags: [] } });
  });

  it("marks a block 「!」 and takes it off, apart from how far it was read", () => {
    const a = agent(main, "长回复");
    service.reviewProgress.update(main.id, { read: { id: a, blocks: 3, of: 6, at: "c" } });
    service.reviewProgress.update(main.id, { flag: { id: a, block: 4, quote: "第五段的开头", on: true } });
    expect(service.reviewProgress.update(main.id, { flag: { id: a, block: 1, quote: "第二段", on: true } }).replies[a]).toEqual({ read: 3, of: 6, at: "c", flags: [{ block: 1, quote: "第二段" }, { block: 4, quote: "第五段的开头" }] });
    // Read taken back: the 「!」 stay.
    expect(service.reviewProgress.update(main.id, { read: { id: a, blocks: 0, of: 6 } }).replies[a]).toEqual({ read: 0, of: 6, flags: [{ block: 1, quote: "第二段" }, { block: 4, quote: "第五段的开头" }] });
    service.reviewProgress.update(main.id, { flag: { id: a, block: 1, quote: "", on: false } });
    // The last 「!」 off with nothing read: gone.
    expect(service.reviewProgress.update(main.id, { flag: { id: a, block: 4, quote: "", on: false } }).replies).toEqual({});
  });

  it("到这里为止都读过 marks several at once, keeping their 「!」 and leaving out ids that are not this session's replies", () => {
    const a = agent(main, "一");
    const b = agent(main, "二");
    const asked = user(main, "人的消息");
    const other = session(store.createTask({ title: "别的", workspaceId: alpha.id }).id);
    const elsewhere = agent(other, "别的会话的回复");
    service.reviewProgress.update(main.id, { read: { id: a, blocks: 1, of: 3, at: "x" } });
    service.reviewProgress.update(main.id, { flag: { id: b, block: 0, quote: "二", on: true } });
    const { replies } = service.reviewProgress.update(main.id, { readUpTo: [a, b, asked, elsewhere, "item-gone"] });
    expect(replies).toEqual({ [a]: { read: "all", of: 3, flags: [] }, [b]: { read: "all", flags: [{ block: 0, quote: "二" }] } });
    expect(service.reviewProgress.get(other.id).replies).toEqual({});
  });

  it("reads 第一版's marks: 审过 is read to the end, 浏览过 is dropped", () => {
    const a = agent(main, "一");
    const b = agent(main, "二");
    store.setKv(`review-progress:${main.id}`, JSON.stringify({ marks: { [a]: "reviewed", [b]: "seen" } }));
    expect(service.reviewProgress.get(main.id).replies).toEqual({ [a]: { read: "all", flags: [] } });
  });

  it("refuses what is not a change it knows, and anything while the 测试功能 is off", () => {
    const a = agent(main, "一");
    const asked = user(main, "人的消息");
    expect(() => service.reviewProgress.update(main.id, { read: { id: asked, blocks: 1, of: 2 } })).toThrow("read.id 不是这个会话的回复");
    expect(() => service.reviewProgress.update(main.id, { read: { id: a, blocks: 3, of: 2 } })).toThrow("read.blocks 不能比 read.of 大");
    expect(() => service.reviewProgress.update(main.id, { read: { id: a, blocks: 1.5, of: 2 } })).toThrow("read.blocks 要是 0 以上的整数");
    expect(() => service.reviewProgress.update(main.id, { flag: { id: a, block: 0, quote: "x" } })).toThrow("flag.on 要是 true 或 false");
    expect(() => service.reviewProgress.update(main.id, { readUpTo: a })).toThrow("readUpTo 要是回复 id 的列表");
    expect(() => service.reviewProgress.get("s-missing")).toThrow();
    service.config.updateSettings({ experimentalFeatures: [] });
    expect(() => service.reviewProgress.update(main.id, { read: { id: a, blocks: 1, of: 2 } })).toThrow("测试功能「审阅进度」没有打开");
    expect(service.reviewProgress.get(main.id).replies).toEqual({});
  });

  it("goes with its session when that is deleted", () => {
    const a = agent(main, "一");
    service.reviewProgress.update(main.id, { readUpTo: [a] });
    expect(store.getKv(`review-progress:${main.id}`)).toBeTruthy();
    store.purge({ sessionIds: [main.id], taskIds: [], topicIds: [], workspaceIds: [] });
    expect(store.getKv(`review-progress:${main.id}`)).toBeUndefined();
  });
});
