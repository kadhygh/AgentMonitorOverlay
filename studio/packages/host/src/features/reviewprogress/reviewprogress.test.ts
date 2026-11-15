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

// 审阅进度 (2026-11-16): each reply of a session 没看 / 浏览过 / 审过, kept by the Host by the reply's row id.

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
  it("starts with nothing seen, records 浏览过 and 审过, and says so once per change", () => {
    const a = agent(main, "第一条");
    const b = agent(main, "第二条");
    expect(service.reviewProgress.get(main.id)).toEqual({ sessionId: main.id, marks: {} });
    expect(service.reviewProgress.update(main.id, { seen: [a] }).marks).toEqual({ [a]: "seen" });
    expect(service.reviewProgress.update(main.id, { reviewed: [b] }).marks).toEqual({ [a]: "seen", [b]: "reviewed" });
    // The same again changes nothing and says nothing.
    service.reviewProgress.update(main.id, { seen: [a], reviewed: [b] });
    expect(changes()).toHaveLength(2);
    expect(changes().at(-1)).toMatchObject({ sessionId: main.id, marks: { [a]: "seen", [b]: "reviewed" } });
    // Kept: a new Host on the same store reads it back.
    expect(new HostService(store, new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") }).reviewProgress.get(main.id).marks).toEqual({ [a]: "seen", [b]: "reviewed" });
  });

  it("never lets 浏览过 take 审过 away; taking 审过 back leaves it 浏览过", () => {
    const a = agent(main, "长回复");
    service.reviewProgress.update(main.id, { reviewed: [a] });
    expect(service.reviewProgress.update(main.id, { seen: [a] }).marks[a]).toBe("reviewed");
    expect(service.reviewProgress.update(main.id, { unreviewed: [a] }).marks[a]).toBe("seen");
    // Taking back one that was not 审过 does nothing (it stays 没看).
    const b = agent(main, "另一条");
    expect(service.reviewProgress.update(main.id, { unreviewed: [b] }).marks[b]).toBeUndefined();
  });

  it("marks several at once (到这里为止都审过), leaving out ids that are not this session's replies", () => {
    const a = agent(main, "一");
    const b = agent(main, "二");
    const asked = user(main, "人的消息");
    const other = session(store.createTask({ title: "别的", workspaceId: alpha.id }).id);
    const elsewhere = agent(other, "别的会话的回复");
    const { marks } = service.reviewProgress.update(main.id, { seen: [a], reviewed: [a, b, asked, elsewhere, "item-gone"] });
    expect(marks).toEqual({ [a]: "reviewed", [b]: "reviewed" });
    expect(service.reviewProgress.get(other.id).marks).toEqual({});
  });

  it("refuses what is not a list of ids, and anything while the 测试功能 is off", () => {
    const a = agent(main, "一");
    expect(() => service.reviewProgress.update(main.id, { seen: a })).toThrow("seen 要是回复 id 的列表");
    expect(() => service.reviewProgress.update(main.id, { reviewed: [1] })).toThrow("reviewed 要是回复 id 的列表");
    expect(() => service.reviewProgress.get("s-missing")).toThrow();
    service.config.updateSettings({ experimentalFeatures: [] });
    expect(() => service.reviewProgress.update(main.id, { seen: [a] })).toThrow("测试功能「审阅进度」没有打开");
    expect(service.reviewProgress.get(main.id).marks).toEqual({});
  });

  it("goes with its session when that is deleted", () => {
    const a = agent(main, "一");
    service.reviewProgress.update(main.id, { reviewed: [a] });
    expect(store.getKv(`review-progress:${main.id}`)).toBeTruthy();
    store.purge({ sessionIds: [main.id], taskIds: [], topicIds: [], workspaceIds: [] });
    expect(store.getKv(`review-progress:${main.id}`)).toBeUndefined();
  });
});
