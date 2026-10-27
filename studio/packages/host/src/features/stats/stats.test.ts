import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { localDate } from "./service.js";

// 设置 → 统计 (2026-10-27): tokens per day and model, from the turns.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-claude", label: "Claude", runtime: "claude", provider: "anthropic", model: null },
];

let root: string;
let servers: FakeServers;
let store: Store;
let host: HostService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-stats-"));
  mkdirSync(join(root, "alpha"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  host = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
});

afterEach(async () => {
  store?.close();
  await servers?.close();
  removeTempDir(root);
});

let n = 0;
function session(taskId: string, workspaceId: string, profileId: string, kind: Session["kind"] = "main", parentId: string | null = null): Session {
  return store.createSession({ taskId, topicId: null, parentId, kind, runtime: profileId === "p-ds" ? "codex" : "claude", profileId, workspaceId, title: profileId, status: "idle", writer: "workbench", runtimeRef: null });
}
function turn(sessionId: string, startedAt: string, usage?: { input: number; cachedInput: number; output: number }): void {
  n += 1;
  store.appendItem({ id: `t${n}`, sessionId, type: "turn", turnId: `turn-${n}`, state: "completed", startedAt, createdAt: startedAt, ...(usage ? { usage: { ...usage, reasoning: 0 } } : {}) } as never);
}

describe("token stats", () => {
  it("counts each turn once, per local day and model; input leaves out what came from the cache; subagents count under their own model", async () => {
    const ws = host.projects.addWorkspace({ path: join(root, "alpha") });
    const task = (await host.tasks.createTask({ title: "统计", workspaceId: ws.id })).task;
    const ds = session(task.id, ws.id, "p-ds");
    const claude = session(task.id, ws.id, "p-claude");
    const sub = session(task.id, ws.id, "p-ds", "sub", claude.id);
    const gone = session(task.id, ws.id, "ch-deleted");
    const day1 = new Date(2026, 9, 26, 10).toISOString(), day1late = new Date(2026, 9, 26, 23, 50).toISOString(), day2 = new Date(2026, 9, 27, 0, 10).toISOString();
    turn(ds.id, day1, { input: 1000, cachedInput: 600, output: 50 });
    turn(ds.id, day1late, { input: 500, cachedInput: 0, output: 20 });
    turn(ds.id, day2, { input: 300, cachedInput: 300, output: 10 });
    turn(claude.id, day2, { input: 2000, cachedInput: 1500, output: 100 });
    turn(sub.id, day2, { input: 100, cachedInput: 0, output: 5 });
    turn(gone.id, day2, { input: 10, cachedInput: 0, output: 1 });
    turn(claude.id, day2); // no usage (interrupted before any call): not counted
    turn(claude.id, day2, { input: 0, cachedInput: 0, output: 0 });

    const stats = host.stats.tokens();
    expect(stats.turns).toBe(6);
    expect(stats.days).toEqual([
      { date: "2026-10-26", profileId: "p-ds", input: 900, cached: 600, output: 70, turns: 2 },
      { date: "2026-10-27", profileId: "ch-deleted", input: 10, cached: 0, output: 1, turns: 1 },
      { date: "2026-10-27", profileId: "p-claude", input: 500, cached: 1500, output: 100, turns: 1 },
      { date: "2026-10-27", profileId: "p-ds", input: 100, cached: 300, output: 15, turns: 2 },
    ]);
    expect(stats.models.sort((a, b) => a.profileId.localeCompare(b.profileId))).toEqual([
      { profileId: "ch-deleted", label: "ch-deleted", runtime: null, model: null, removed: true },
      { profileId: "p-claude", label: "Claude", runtime: "claude", model: null, removed: false },
      { profileId: "p-ds", label: "DS", runtime: "codex", model: "ds-model", removed: false },
    ]);
    expect(Date.parse(stats.generatedAt)).not.toBeNaN();
  });

  it("dates by the local day", () => {
    expect(localDate(new Date(2026, 0, 5, 0, 30).toISOString())).toBe("2026-01-05");
    expect(localDate("not a time")).toBeNull();
  });
});
