import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc, ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "./runtime/codex/codex-runtime.js";
import { FakeServers } from "./runtime/codex/fake-servers.test-support.js";
import { HostService } from "./service.js";
import { MIGRATIONS } from "./store/migrations.js";
import { Store } from "./store/store.js";

// Structure v2 (design/structure.md) on data from before it: a database at schema 6 with a cross-workspace task whose
// sessions ran in two projects, a workspace task, the single global canvas and the common space as a plain workspace.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const AT = "2026-10-01T00:00:00.000Z";

let root: string;
let servers: FakeServers;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-structure-"));
  for (const dir of ["alpha", "beta", "commons"]) mkdirSync(join(root, dir));
});

afterEach(async () => {
  store?.close();
  await servers?.close();
  removeTempDir(root);
});

function legacyDatabase(path: string, withLegacyCommon: boolean): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  MIGRATIONS.slice(0, 6).forEach((m, i) => {
    db.exec(m as string);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(i + 1, AT);
  });
  const ws = db.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)");
  ws.run("ws-a", "alpha", join(root, "alpha"), AT);
  ws.run("ws-b", "beta", join(root, "beta"), AT);
  ws.run("ws-c", "公共空间", join(root, "commons"), AT);
  if (withLegacyCommon) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run("settings:common-workspace", "ws-c", AT);
  const task = db.prepare("INSERT INTO tasks (id, title, scope_kind, workspace_id, column_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  task.run("t-area", "统一配置键", "area", null, "doing", AT, AT);
  task.run("t-empty", "空的跨区任务", "area", null, "todo", AT, AT);
  task.run("t-ws", "导入重试", "workspace", "ws-a", "doing", AT, AT);
  const session = db.prepare(
    "INSERT INTO sessions (id, task_id, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, 'codex', 'p-ds', ?, ?, 'idle', 'workbench', NULL, ?, ?, NULL)",
  );
  session.run("s-a", "t-area", null, "main", "ws-a", "alpha 里", "2026-10-01T00:00:01.000Z", AT);
  session.run("s-a-fork", "t-area", "s-a", "fork", "ws-a", "alpha 分支", "2026-10-01T00:00:02.000Z", AT);
  session.run("s-b", "t-area", null, "main", "ws-b", "beta 里", "2026-10-01T00:00:03.000Z", AT);
  session.run("s-b-sub", "t-area", "s-b", "sub", "ws-b", "beta 子 agent", "2026-10-01T00:00:04.000Z", AT);
  session.run("s-ws", "t-ws", null, "main", "ws-a", "导入", "2026-10-01T00:00:05.000Z", AT);
  db.prepare("INSERT INTO items (session_id, seq, id, type, created_at, body) VALUES ('s-b', 1, 'i-1', 'user', ?, ?)").run(AT, JSON.stringify({ id: "i-1", sessionId: "s-b", type: "user", text: "hi", createdAt: AT }));
  db.prepare("INSERT INTO decisions (id, session_id, task_id, state, body, created_at) VALUES ('d-1', 's-b', 't-area', 'open', '{}', ?)").run(AT);
  const canvas: CanvasDoc = {
    id: "main",
    version: 4,
    groups: [{ id: "g1", title: "导入", workspaceId: "ws-a", rect: { x: 0, y: 0, w: 400, h: 300 } }],
    nodes: [
      { id: "n1", kind: "task", taskId: "t-ws", groupId: "g1", pos: { x: 10, y: 40 } },
      { id: "n2", kind: "task", taskId: "t-area", groupId: null, pos: { x: 600, y: 40 } },
      { id: "n3", kind: "note", text: "先问策划", groupId: null, pos: { x: 600, y: 300 } },
    ],
    edges: [{ id: "e1", kind: "depends", from: "t-area", to: "t-ws" }],
    updatedAt: AT,
  };
  db.prepare("INSERT INTO canvas_docs (id, body, updated_at) VALUES ('main', ?, ?)").run(JSON.stringify(canvas), AT);
  db.close();
}

function open(path: string): HostService {
  store = new Store(path);
  servers = new FakeServers(PROFILES);
  return new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
}

describe("structure v2 on older data", () => {
  it("keeps every row, gives area tasks a workspace (and a topic when they spanned projects) and turns the canvas into a topic", () => {
    const path = join(root, "studio.db");
    legacyDatabase(path, true);
    const service = open(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);

    // The old common space is now the built-in one.
    expect(service.commonWorkspace()).toMatchObject({ id: "ws-c", builtin: "common" });

    // The task that ran in alpha and beta stays in alpha (its first session); a topic of its name takes the beta tree.
    const area = store.getTask("t-area")!;
    expect(area.workspaceId).toBe("ws-a");
    const spanning = store.listTopics().find((t) => t.title === "统一配置键")!;
    expect(spanning.workspaceIds).toEqual(["ws-a", "ws-b"]);
    expect(area.topicId).toBe(spanning.id);
    expect(store.listSessions({ taskId: "t-area" }).map((s) => s.id).sort()).toEqual(["s-a", "s-a-fork"]);
    expect(store.listSessions({ topicId: spanning.id }).map((s) => s.id).sort()).toEqual(["s-b", "s-b-sub"]);
    expect(store.listItems("s-b")).toHaveLength(1);
    expect(store.getDecision("d-1")).toBeDefined();

    // A cross-workspace task without sessions lands in the common space.
    expect(store.getTask("t-empty")).toMatchObject({ workspaceId: "ws-c", topicId: null });

    // The global canvas became "专题 1" with the tasks placed on it, except the one that already got a topic.
    const first = store.listTopics().find((t) => t.title === "专题 1")!;
    expect(store.getTask("t-ws")!.topicId).toBe(first.id);
    const canvas = service.canvas(first.id);
    expect(canvas.version).toBe(4);
    expect(canvas.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(canvas.edges).toEqual([]);
    expect(store.getCanvas("main")).toBeUndefined();

    // Nothing is left to resolve, and a second start changes nothing.
    expect(store.listTasksWithoutWorkspace()).toEqual([]);
    const topics = store.listTopics().length;
    store.close();
    void servers.close();
    open(path);
    expect(store.listTopics()).toHaveLength(topics);
  });

  it("makes the common space next to the database when there was none", () => {
    const path = join(root, "studio.db");
    legacyDatabase(path, false);
    const service = open(path);
    expect(service.commonWorkspace()).toMatchObject({ path: join(root, "common"), name: "公共", builtin: "common" });
    // The old plain "公共空间" workspace is an ordinary project now.
    expect(store.getWorkspace("ws-c")?.builtin).toBeUndefined();
  });
});
