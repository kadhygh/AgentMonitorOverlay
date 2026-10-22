import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 项目分组 (2026-10-22): the left column's project groups, kept with Studio's settings.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let beta: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-groups-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  for (const name of ["alpha", "beta"]) mkdirSync(join(root, name));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  beta = store.addWorkspace({ path: join(root, "beta"), name: "beta" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("项目分组", () => {
  it("starts empty, and keeps groups in order with their names, notes and projects", () => {
    expect(service.config.settings().projectGroups).toEqual([]);
    const events: HostEvent[] = [];
    service.on("event", (e: HostEvent) => events.push(e));
    const saved = service.config.updateSettings({
      projectGroups: [
        { name: "客户端", description: "Unity 客户端", workspaceIds: [alpha.id] },
        { name: "工具", description: "", workspaceIds: [beta.id] },
      ],
    }).projectGroups;
    expect(saved.map((g) => [g.name, g.description, g.workspaceIds])).toEqual([
      ["客户端", "Unity 客户端", [alpha.id]],
      ["工具", "", [beta.id]],
    ]);
    expect(saved[0]!.id).toMatch(/^pg/);
    expect(events.some((e) => e.type === "settings.updated" && e.settings.projectGroups.length === 2)).toBe(true);
    // Ids are kept when the list is saved again.
    expect(service.config.updateSettings({ projectGroups: [...saved].reverse() }).projectGroups.map((g) => g.id)).toEqual([saved[1]!.id, saved[0]!.id]);
  });

  it("puts a project in one group only and drops unknown ones", () => {
    const saved = service.config.updateSettings({
      projectGroups: [
        { name: "A", description: "", workspaceIds: [alpha.id, "ws-gone", alpha.id] },
        { name: "B", description: "", workspaceIds: [alpha.id, beta.id] },
      ],
    }).projectGroups;
    expect(saved.map((g) => g.workspaceIds)).toEqual([[alpha.id], [beta.id]]);
  });

  it("refuses a group without a name or a list that is not one", () => {
    expect(() => service.config.updateSettings({ projectGroups: [{ name: " ", description: "", workspaceIds: [] }] })).toThrow(/name/);
    expect(() => service.config.updateSettings({ projectGroups: "x" })).toThrow(/projectGroups/);
  });
});
