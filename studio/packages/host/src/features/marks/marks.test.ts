import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bookmark, ChatMark, FileMark, HostEvent, ModelProfile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { isInside, pathKey, projectOf } from "./service.js";
import { marksTools } from "./mcp.js";
import { toolContext, type ToolResult } from "../../mcp/tool-kit.js";

// File marks (stage 12, S12-D) through the Host API: marking, dedupe, which project a path belongs to, edits, deleting
// with the project, and the events that keep open windows current.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let http: HostServer;
let events: HostEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-marks-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  events = [];
  service.on("event", (e) => events.push(e));
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}
const ok = async <T>(method: string, path: string, body?: unknown) => {
  const r = await api<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

function project(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

type Created = { mark: FileMark; created: boolean };

describe("file mark paths", () => {
  const R = resolve("/amo-marks-test");
  it("compares paths without a trailing separator (and without case on Windows)", () => {
    expect(pathKey(join(R, "game") + "\\")).toBe(pathKey(join(R, "game")));
    expect(isInside(join(R, "game", "a.lua"), join(R, "game"))).toBe(true);
    expect(isInside(join(R, "game2", "a.lua"), join(R, "game"))).toBe(false);
    expect(isInside(join(R, "game"), join(R, "game"))).toBe(true);
    if (process.platform === "win32") expect(isInside("C:\\Game\\A.lua", "c:\\game")).toBe(true);
  });

  it("puts a path in the innermost project, never in the common space", () => {
    const ws = (id: string, path: string, builtin?: "common"): Workspace => ({ id, name: id, path, createdAt: "", ...(builtin ? { builtin } : {}) });
    const all = [ws("outer", join(R, "src")), ws("inner", join(R, "src", "game")), ws("common", join(R, "common"), "common")];
    expect(projectOf(join(R, "src", "game", "drop.lua"), all)).toBe("inner");
    expect(projectOf(join(R, "src", "tool.ts"), all)).toBe("outer");
    expect(projectOf(join(R, "common", "x.md"), all)).toBeNull();
    expect(projectOf(join(R, "elsewhere.txt"), all)).toBeNull();
  });
});

describe("file marks API", { timeout: 30_000 }, () => {
  it("marks files, derives the project, dedupes the same path and range, and lists by project", async () => {
    const dir = project("game", { "drop.lua": "a\nb\nc\n", "docs/readme.md": "# hi\n" });
    const elsewhere = project("loose", { "notes.txt": "x" });
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: dir });

    const first = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua"), note: "  掉落表  " });
    expect(first.created).toBe(true);
    expect(first.mark).toMatchObject({ workspaceId: ws.id, note: "掉落表", startLine: null, endLine: null, exists: true, folder: false });
    expect(events.filter((e) => e.type === "marks.changed")).toEqual([expect.objectContaining({ markId: first.mark.id, workspaceId: ws.id })]);

    // The same file again (another spelling, quoted as Explorer's "Copy as path" does) is the same mark.
    const again = await ok<Created>("POST", "/api/file-marks", { path: `"${join(dir, ".", "drop.lua")}"` });
    expect(again).toMatchObject({ created: false, mark: { id: first.mark.id } });
    // A line range makes another one; relative paths resolve against the project given.
    const ranged = await ok<Created>("POST", "/api/file-marks", { path: "drop.lua", workspaceId: ws.id, startLine: 2, endLine: 3 });
    expect(ranged.created).toBe(true);
    expect(ranged.mark.path).toBe(join(dir, "drop.lua"));
    const single = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua"), startLine: 2, endLine: 2 });
    expect(single.mark).toMatchObject({ startLine: 2, endLine: null });

    const folder = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "docs") });
    expect(folder.mark.folder).toBe(true);
    const other = await ok<Created>("POST", "/api/file-marks", { path: join(elsewhere, "notes.txt"), note: "随手记" });
    expect(other.mark.workspaceId).toBeNull();

    // Newest first within a project; per project, or 其他.
    const mine = await ok<FileMark[]>("GET", `/api/file-marks?workspace=${ws.id}`);
    expect(mine.map((m) => m.id)).toEqual([folder.mark.id, single.mark.id, ranged.mark.id, first.mark.id]);
    expect((await ok<FileMark[]>("GET", "/api/file-marks?workspace=other")).map((m) => m.id)).toEqual([other.mark.id]);
    expect(await ok<FileMark[]>("GET", "/api/file-marks")).toHaveLength(5);

    // Refused: a missing file, a bad range, a range on a folder, an unknown project.
    expect((await api("POST", "/api/file-marks", { path: join(dir, "nope.lua") })).status).toBe(404);
    expect((await api("POST", "/api/file-marks", { path: join(dir, "drop.lua"), startLine: 3, endLine: 2 })).status).toBe(400);
    expect((await api("POST", "/api/file-marks", { path: join(dir, "drop.lua"), endLine: 2 })).status).toBe(400);
    expect((await api("POST", "/api/file-marks", { path: join(dir, "docs"), startLine: 1 })).status).toBe(400);
    expect((await api("POST", "/api/file-marks", { path: "drop.lua" })).status).toBe(400);
    expect((await api("GET", "/api/file-marks?workspace=ws-nope")).status).toBe(404);
  });

  it("edits the note, range and order, reports missing files, and deletes", async () => {
    const dir = project("game", { "drop.lua": "a\n", "boss.lua": "b\n" });
    await ok<Workspace>("POST", "/api/workspaces", { path: dir });
    const a = (await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua") })).mark;
    const b = (await ok<Created>("POST", "/api/file-marks", { path: join(dir, "boss.lua") })).mark;

    const edited = await ok<FileMark>("PATCH", `/api/file-marks/${a.id}`, { note: "概率在这里\n第二行" });
    expect(edited.note).toBe("概率在这里\n第二行");
    expect(edited.updatedAt >= a.updatedAt).toBe(true);
    expect((await ok<FileMark>("PATCH", `/api/file-marks/${a.id}`, { startLine: 4, endLine: 9 })).startLine).toBe(4);
    expect(await ok<FileMark>("PATCH", `/api/file-marks/${a.id}`, { startLine: null })).toMatchObject({ startLine: null, endLine: null });
    expect((await api("PATCH", `/api/file-marks/${a.id}`, { note: "x".repeat(5000) })).status).toBe(400);
    // The newer one is on top; moving it below the other.
    expect((await ok<FileMark[]>("GET", "/api/file-marks")).map((m) => m.id)).toEqual([b.id, a.id]);
    await ok("PATCH", `/api/file-marks/${b.id}`, { order: a.order + 1 });
    expect((await ok<FileMark[]>("GET", "/api/file-marks")).map((m) => m.id)).toEqual([a.id, b.id]);

    // A file that goes away stays marked, flagged as missing.
    rmSync(join(dir, "boss.lua"));
    expect((await ok<FileMark[]>("GET", "/api/file-marks")).find((m) => m.id === b.id)).toMatchObject({ exists: false });

    const before = events.length;
    expect(await ok("DELETE", `/api/file-marks/${b.id}`)).toEqual({ ok: true });
    expect(events.slice(before)).toEqual([expect.objectContaining({ type: "marks.changed", markId: b.id })]);
    expect((await api("DELETE", `/api/file-marks/${b.id}`)).status).toBe(404);
    expect((await api("PATCH", "/api/file-marks/mark-nope", { note: "x" })).status).toBe(404);
  });

  it("deletes a project's marks with the project; 其他 marks move into a project added later", async () => {
    const dir = project("game", { "drop.lua": "a\n" });
    const later = project("later", { "plan.md": "# plan\n" });
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: dir });
    await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua") });
    const loose = (await ok<Created>("POST", "/api/file-marks", { path: join(later, "plan.md") })).mark;
    expect(loose.workspaceId).toBeNull();

    const added = await ok<Workspace>("POST", "/api/workspaces", { path: later });
    expect((await ok<FileMark[]>("GET", `/api/file-marks?workspace=${added.id}`)).map((m) => m.id)).toEqual([loose.id]);

    await ok("DELETE", `/api/workspaces/${ws.id}`);
    expect((await ok<FileMark[]>("GET", "/api/file-marks")).map((m) => m.id)).toEqual([loose.id]);
  });
});

describe("list_file_marks (AMO MCP)", () => {
  it("reads the caller's project by default, another project by name, 其他 or all", async () => {
    const dir = project("game", { "drop.lua": "a\n" });
    const elsewhere = project("loose", { "notes.txt": "x" });
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: dir });
    await ok("POST", "/api/file-marks", { path: join(dir, "drop.lua"), startLine: 2, endLine: 5, note: "掉落表" });
    await ok("POST", "/api/file-marks", { path: join(elsewhere, "notes.txt") });
    const task = store.createTask({ title: "t", workspaceId: ws.id });
    const session = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: null });

    const tool = (caller: { sessionId: string } | null) => marksTools(toolContext(service, caller)).find((t) => t.name === "list_file_marks")!;
    const read = (caller: { sessionId: string } | null, args: Record<string, unknown> = {}) => {
      const r = tool(caller).run(args) as ToolResult; // a read answers at once
      return r.isError ? { error: true, data: r.content[0]!.text } : { error: false, data: JSON.parse(r.content[0]!.text) as unknown };
    };
    expect(read({ sessionId: session.id }).data).toEqual([{ path: join(dir, "drop.lua"), lines: "2-5", note: "掉落表", project: "game" }]);
    expect(read(null, { workspace: "game" }).data).toHaveLength(1);
    expect(read(null, { workspace: "other" }).data).toEqual([{ path: join(elsewhere, "notes.txt"), note: "", project: "其他" }]);
    expect(read(null).data).toHaveLength(2);
    expect(read(null, { workspace: "all" }).data).toHaveLength(2);
    expect(read(null, { workspace: "nope" })).toEqual({ error: true, data: "没有叫 nope 的项目" });
  });
});

describe("书签 (2026-10-19)", { timeout: 30_000 }, () => {
  it("keeps files and passages under topics, picks the topic from the session, moves and deletes them", async () => {
    const dir = project("game", { "drop.lua": "a\nb\n" });
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: dir });
    const topic = store.createTopic({ title: "掉落" });
    const other = store.createTopic({ title: "战斗" });
    const task = store.createTask({ title: "t", workspaceId: ws.id, topicId: topic.id });
    const session = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: ws.id, title: "调掉落", status: "idle", writer: "workbench", runtimeRef: null });
    const reply = store.appendItem({ id: "i-reply", sessionId: session.id, createdAt: new Date().toISOString(), type: "agent", markdown: "先改 **掉落表**，再跑校验。" } as never);
    const passage = { sessionId: session.id, itemId: reply.id, start: 2, end: 11, quote: "掉落表", prefix: "先改 ", suffix: "，再跑" };

    // A passage goes under its session's topic; the same passage again is the same bookmark.
    const chat = await ok<{ mark: ChatMark; created: boolean }>("POST", "/api/chat-marks", { ...passage, note: " 关键 " });
    expect(chat).toMatchObject({ created: true, mark: { kind: "chat", topicId: topic.id, note: "关键", taskId: task.id, workspaceId: ws.id, sessionTitle: "调掉落", exists: true } });
    expect((await ok<{ created: boolean }>("POST", "/api/chat-marks", passage)).created).toBe(false);
    expect(events.filter((e) => e.type === "marks.changed").at(-1)).toMatchObject({ markId: chat.mark.id, topicId: topic.id });
    // A file marked from that session's viewer goes there too; with no session, under 未归专题.
    const file = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua"), sessionId: session.id });
    expect(file.mark).toMatchObject({ kind: "file", topicId: topic.id });
    const loose = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua"), startLine: 2 });
    expect(loose.mark.topicId).toBeNull();
    // The same file under another topic is another bookmark.
    const again = await ok<Created>("POST", "/api/file-marks", { path: join(dir, "drop.lua"), topicId: other.id });
    expect(again).toMatchObject({ created: true, mark: { topicId: other.id } });

    // By topic, newest first, files and passages together.
    expect((await ok<Bookmark[]>("GET", `/api/bookmarks?topic=${topic.id}`)).map((m) => m.id)).toEqual([file.mark.id, chat.mark.id]);
    expect((await ok<Bookmark[]>("GET", "/api/bookmarks?topic=none")).map((m) => m.id)).toEqual([loose.mark.id]);
    expect(await ok<Bookmark[]>("GET", "/api/bookmarks")).toHaveLength(4);

    // Moving a passage to another topic puts it on top there; a note on either kind; ranges only on files.
    const moved = await ok<ChatMark>("PATCH", `/api/bookmarks/${chat.mark.id}`, { topicId: other.id, note: "移过来" });
    expect(moved).toMatchObject({ topicId: other.id, note: "移过来" });
    expect((await ok<Bookmark[]>("GET", `/api/bookmarks?topic=${other.id}`)).map((m) => m.id)).toEqual([chat.mark.id, again.mark.id]);
    expect((await api("PATCH", `/api/bookmarks/${chat.mark.id}`, { startLine: 1 })).status).toBe(400);
    expect((await ok<FileMark>("PATCH", `/api/bookmarks/${loose.mark.id}`, { topicId: topic.id })).topicId).toBe(topic.id);
    // The same file and range is under that topic already.
    expect((await api("PATCH", `/api/bookmarks/${again.mark.id}`, { topicId: topic.id })).status).toBe(409);

    // Refused: an unknown session, a reply of another session, an empty range, an unknown topic.
    expect((await api("POST", "/api/chat-marks", { ...passage, sessionId: "s-nope" })).status).toBe(404);
    expect((await api("POST", "/api/chat-marks", { ...passage, itemId: "i-nope" })).status).toBe(404);
    expect((await api("POST", "/api/chat-marks", { ...passage, end: 2 })).status).toBe(400);
    expect((await api("POST", "/api/chat-marks", { ...passage, topicId: "topic-nope" })).status).toBe(404);

    // A deleted topic leaves its bookmarks under 未归专题.
    store.purge({ sessionIds: [], taskIds: [], topicIds: [other.id], workspaceIds: [] });
    expect((await ok<Bookmark[]>("GET", "/api/bookmarks?topic=none")).map((m) => m.id).sort()).toEqual([again.mark.id, chat.mark.id].sort());

    await ok("DELETE", `/api/bookmarks/${chat.mark.id}`);
    await ok("DELETE", `/api/bookmarks/${file.mark.id}`);
    expect(await ok<Bookmark[]>("GET", "/api/bookmarks")).toHaveLength(2);
    expect((await api("DELETE", `/api/bookmarks/${chat.mark.id}`)).status).toBe(404);
  });
});
