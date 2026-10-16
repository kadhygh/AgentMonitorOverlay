import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "./store.js";

const open: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) removeTempDir(dirs.pop()!);
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-store-"));
  dirs.push(dir);
  return join(dir, "studio.db");
}

function makeStore(path = ":memory:"): Store {
  let tick = 0;
  // Deterministic, strictly increasing timestamps keep ordering assertions stable.
  const store = new Store(path, () => new Date(Date.UTC(2026, 9, 12, 10, 0, tick++)));
  open.push(store);
  return store;
}

function seed(store: Store) {
  const ws = store.addWorkspace({ path: "C:/sandbox/alpha", name: "alpha" });
  const task = store.createTask({ title: "Retry", workspaceId: ws.id });
  const base = { taskId: task.id, topicId: null, runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: null } as const;
  const main = store.createSession({ ...base, parentId: null, kind: "main" });
  const fork = store.createSession({ ...base, parentId: main.id, kind: "fork" });
  const sub = store.createSession({ ...base, parentId: fork.id, kind: "sub" });
  const other = store.createSession({ ...base, parentId: null, kind: "main" });
  return { ws, task, main, fork, sub, other };
}

describe("Store", () => {
  it("applies migrations once", () => {
    const path = tempDbPath();
    expect(makeStore(path).schemaVersion()).toBe(14);
    open.pop()!.close();
    expect(makeStore(path).schemaVersion()).toBe(14);
  });

  it("keeps a session's wake until it is cleared (stage 15)", () => {
    const store = makeStore();
    const { main } = seed(store);
    expect("wake" in store.getSession(main.id)!).toBe(false);
    const loop = { at: "2026-10-16T03:00:00.000Z", reason: "兜底", prompt: "/loop go on" };
    store.updateSession(main.id, { wake: { loop } });
    expect(store.getSession(main.id)!.wake).toEqual({ loop });
    // Other changes leave it alone.
    expect(store.updateSession(main.id, { status: "running" }).wake).toEqual({ loop });
    expect(store.getSession(main.id)!.wake).toEqual({ loop });
    // Cleared by null, or by one with nothing in it.
    store.updateSession(main.id, { wake: {} });
    expect("wake" in store.getSession(main.id)!).toBe(false);
    store.updateSession(main.id, { wake: { loop } });
    expect("wake" in store.updateSession(main.id, { wake: null })).toBe(false);
    expect("wake" in store.getSession(main.id)!).toBe(false);
  });

  it("creates, reads and updates workspaces, tasks and sessions", () => {
    const store = makeStore();
    const { ws, task, main } = seed(store);
    expect(store.findWorkspaceByPath("C:/sandbox/alpha")?.id).toBe(ws.id);
    expect(store.updateTask(task.id, { column: "doing" }).column).toBe("doing");
    expect(store.getTask(task.id)?.column).toBe("doing");
    const topic = store.createTopic({ title: "掉落表重构", workspaceIds: [ws.id] });
    expect(store.updateTask(task.id, { topicId: topic.id }).topicId).toBe(topic.id);
    expect(store.updateTopic(topic.id, { title: "掉落表" })).toMatchObject({ title: "掉落表", workspaceIds: [ws.id], archivedAt: null });
    expect(store.listTopics().map((t) => t.id)).toEqual([topic.id]);
    store.updateSession(main.id, { status: "running", runtimeRef: "thread-1" });
    expect(store.findSessionByRuntimeRef("codex", "thread-1")?.id).toBe(main.id);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(4);
  });

  it("rejects a duplicate workspace path and removing a workspace in use", () => {
    const store = makeStore();
    const { ws } = seed(store);
    expect(() => store.addWorkspace({ path: "C:/sandbox/alpha", name: "again" })).toThrow();
    expect(() => store.removeWorkspace(ws.id)).toThrow(/still used/);
    const spare = store.addWorkspace({ path: "C:/sandbox/spare", name: "spare" });
    store.removeWorkspace(spare.id);
    expect(store.getWorkspace(spare.id)).toBeUndefined();
  });

  it("archives and restores a session together with its forks and subagents", () => {
    const store = makeStore();
    const { main, fork, sub, other } = seed(store);
    const archived = store.archiveSubtree(main.id);
    expect(archived.map((s) => s.id)).toEqual([main.id, fork.id, sub.id]);
    expect(archived.every((s) => s.writer === "archived" && s.archivedAt)).toBe(true);
    expect(store.getSession(other.id)?.archivedAt).toBeNull();

    // Archiving again changes nothing; restoring a subtree restores only that subtree.
    expect(store.archiveSubtree(main.id)).toEqual([]);
    expect(store.unarchiveSubtree(fork.id).map((s) => s.id)).toEqual([fork.id, sub.id]);
    expect(store.getSession(main.id)?.archivedAt).not.toBeNull();
    expect(store.getSession(sub.id)?.writer).toBe("workbench");
  });

  it("assigns monotonic item seq per session and replaces bodies in place", () => {
    const store = makeStore();
    const { main, fork } = seed(store);
    const at = "2026-10-12T10:00:00.000Z";
    const a = store.appendItem({ id: "i-a", sessionId: main.id, createdAt: at, type: "user", text: "hi" });
    const b = store.appendItem({ id: "i-b", sessionId: main.id, createdAt: at, type: "agent", markdown: "he", streaming: true });
    const c = store.appendItem({ id: "i-c", sessionId: fork.id, createdAt: at, type: "user", text: "fork" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);

    const done = store.replaceItem({ ...(b as Extract<SessionItem, { type: "agent" }>), markdown: "hello", streaming: false });
    expect(done.seq).toBe(2);
    expect(store.listItems(main.id)).toEqual([a, done]);
    expect(store.listItems(main.id, 1)).toEqual([done]);
    expect(() => store.replaceItem({ ...a, sessionId: fork.id })).toThrow(/cannot change/);
    expect(() => store.appendItem({ id: "i-a", sessionId: main.id, createdAt: at, type: "user", text: "dup" })).toThrow();
  });

  it("keeps a global monotonic event log", () => {
    const store = makeStore();
    const { task } = seed(store);
    const e1 = store.appendEvent({ type: "task.upserted", task });
    const e2 = store.appendEvent({ type: "item.delta", sessionId: "s", itemId: "i", append: "x" });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(store.listEvents(e1.seq)).toEqual([e2]);
    expect(store.lastEventSeq()).toBe(e2.seq);
  });

  it("stores annotations, canvas and todos", () => {
    const store = makeStore();
    const { main } = seed(store);
    const at = "2026-10-12T10:00:00.000Z";
    store.putAnnotation({ id: "a1", sessionId: main.id, itemId: "i", quote: "q", start: 0, end: 1, prefix: "", suffix: "", note: "n", createdAt: at, sentAt: null });
    store.putAnnotation({ id: "a1", sessionId: main.id, itemId: "i", quote: "q", start: 0, end: 1, prefix: "", suffix: "", note: "edited", createdAt: at, sentAt: null });
    expect(store.listAnnotations(main.id).map((a) => a.note)).toEqual(["edited"]);
    const canvas = { id: "main", version: 1, groups: [], nodes: [{ id: "n1", kind: "note" as const, text: "x", groupId: null, pos: { x: 1, y: 2 } }], edges: [], updatedAt: at };
    store.putCanvas(canvas);
    expect(store.getCanvas("main")).toEqual(canvas);
    store.putTodo({ id: "t1", text: "later", done: false, workspaceId: null, taskId: null, createdAt: at });
    expect(store.listTodos()).toHaveLength(1);
  });

  it("stores key/value settings", () => {
    const store = makeStore();
    expect(store.getKv("scratchpad")).toBeUndefined();
    store.setKv("scratchpad", "first");
    const second = store.setKv("scratchpad", "second");
    expect(store.getKv("scratchpad")).toEqual(second);
    expect(second.value).toBe("second");
  });

  it("keeps data across a restart", () => {
    const path = tempDbPath();
    const first = makeStore(path);
    const { main } = seed(first);
    first.appendItem({ id: "i-1", sessionId: main.id, createdAt: "2026-10-12T10:00:00.000Z", type: "user", text: "persist me" });
    first.archiveSubtree(main.id);
    const seq = first.appendEvent({ type: "workspace.removed", workspaceId: "x" }).seq;
    open.pop()!.close();

    const second = makeStore(path);
    expect(second.listWorkspaces()).toHaveLength(1);
    expect(second.listSessions().filter((s: Session) => s.archivedAt)).toHaveLength(3);
    expect(second.listItems(main.id).map((i) => i.type === "user" && i.text)).toEqual(["persist me"]);
    expect(second.lastEventSeq()).toBe(seq);
  });
});
