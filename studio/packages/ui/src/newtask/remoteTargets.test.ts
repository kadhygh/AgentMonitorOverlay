import { describe, expect, it } from "vitest";
import type { RemoteCatalog, RemotePeer, RemoteState } from "@amo-studio/protocol";
import { catalogProblem, catalogProjectChoices, catalogTopicChoices, defaultProject, remoteModeShown, remoteTargets } from "./remoteTargets.js";

// 新任务页的「在别的设备上」 (2026-10-29): which devices it offers, when the switch shows, and the rows from a catalog.

const now = Date.parse("2026-10-29T10:00:00Z");
const peer = (name: string, role: "owner" | "guest", online: boolean | null): RemotePeer => ({ account: `${name}的账号`, device: `d_${name}`, name, role, pairedAt: "", online, lastSeen: null });
const state = (peers: RemotePeer[], patch: Partial<RemoteState> = {}): RemoteState => ({
  device: { id: "d_b", name: "B" },
  account: { server: "http://x", name: "笔记本的我" },
  connection: { state: "online", message: null, retryAt: null, since: null },
  peers,
  incoming: [],
  outgoing: [],
  grants: [],
  allowed: { profiles: [], defaultProfile: null, permission: null },
  taskRequests: [],
  asks: [],
  allowedProjects: { workspaceIds: [], common: false },
  security: { sameAccount: "run", otherAccount: "confirm" },
  ...patch,
});
const catalog = (patch: Partial<RemoteCatalog> = {}): RemoteCatalog => ({
  name: "A 台式机",
  topics: [
    { id: "t1", title: "旧专题", workspaceIds: [], lastUsed: "2026-10-01T00:00:00Z" },
    { id: "t2", title: "掉落表", workspaceIds: ["w2"], lastUsed: "2026-10-28T00:00:00Z" },
  ],
  projects: [
    { id: "w1", name: "客户端", lastUsed: null },
    { id: "w2", name: "策划表", lastUsed: "2026-10-20T00:00:00Z" },
  ],
  allowCommon: false,
  models: [{ id: "p", label: "Codex · P" }],
  ...patch,
});

describe("remote targets", () => {
  it("offers only devices that allowed this computer, once each, online first", () => {
    const s = state([peer("甲", "owner", true), peer("乙", "guest", false), peer("丙", "guest", true), peer("丙", "owner", true)]);
    expect(remoteTargets(s, now).map((t) => [t.name, t.presence])).toEqual([
      ["丙", "online"],
      ["乙", "offline"],
    ]);
  });

  it("shows the switch with remote on, logged in and such a device", () => {
    expect(remoteModeShown(null)).toBe(false);
    expect(remoteModeShown(state([peer("甲", "owner", true)]))).toBe(false);
    expect(remoteModeShown(state([peer("乙", "guest", false)]))).toBe(true);
    expect(remoteModeShown(state([peer("乙", "guest", true)], { account: null }))).toBe(false);
    expect(remoteModeShown(state([peer("乙", "guest", true)], { connection: { state: "off", message: null, retryAt: null, since: null } }))).toBe(false);
  });
});

describe("rows from a catalog", () => {
  it("says what the other computer has not ticked", () => {
    expect(catalogProblem(catalog())).toBeNull();
    expect(catalogProblem(catalog({ projects: [] }))).toBe("A 台式机 还没勾远端允许的项目：在那台电脑的 远程 → 远程设置 里勾");
    expect(catalogProblem(catalog({ projects: [], allowCommon: true }))).toBeNull();
    expect(catalogProblem(catalog({ models: [] }))).toBe("A 台式机 还没勾远端允许的模型：在那台电脑的 远程 → 远程设置 里勾");
  });

  it("ranks topics by last use there and puts the topic's projects first", () => {
    expect(catalogTopicChoices(catalog()).map((c) => [c.name, c.group])).toEqual([
      ["掉落表", "recent"],
      ["旧专题", "recent"],
    ]);
    expect(catalogProjectChoices(catalog(), "t2").map((c) => [c.name, c.group])).toEqual([
      ["策划表", "topic"],
      ["客户端", "all"],
    ]);
    expect(catalogProjectChoices(catalog(), null).map((c) => c.id)).toEqual(["w2", "w1"]);
  });

  it("picks the only project when the common folder is not allowed", () => {
    expect(defaultProject(catalog())).toBeNull();
    expect(defaultProject(catalog({ projects: [{ id: "w1", name: "客户端", lastUsed: null }] }))).toBe("w1");
    expect(defaultProject(catalog({ projects: [{ id: "w1", name: "客户端", lastUsed: null }], allowCommon: true }))).toBeNull();
  });
});
