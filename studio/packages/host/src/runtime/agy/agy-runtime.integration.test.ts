import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgyStatus, ModelProfile, ProfileChoices, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { fakeAgyAgent, removeTempDir } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../credentials.js";
import { AGY_PROFILE_ID } from "../profiles.js";

// Gemini sessions on Antigravity (2026-11-24, plans/agy.md) through a whole Host, with a scripted ACP agent standing in
// for `agy acp` (testkit fake-agy-agent.ts). No Google account or model is reached.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: AGY_PROFILE_ID, label: "Gemini", runtime: "agy", provider: "google", model: null },
];

let root: string;
let dataDir: string;
const running: RunningHost[] = [];

async function boot(extra: { env?: NodeJS.ProcessEnv; experimental?: boolean } = {}): Promise<RunningHost> {
  const servers = new FakeServers(PROFILES.filter((p) => p.runtime === "codex"));
  const host = await startHost({
    dataDir,
    port: 0,
    profiles: PROFILES,
    servers: Object.assign(servers, { stopAll: () => servers.close() }),
    credentials: new StaticCredentialReader({}),
    agyAgent: fakeAgyAgent(),
    // What the Host's own environment might hold about Google: agy must not see it.
    agyEnv: { ...process.env, FAKE_AGY_HOME: join(root, "agy-home"), GEMINI_API_KEY: "from-host", Google_Cloud_Project: "p", ...extra.env },
  });
  running.push(host);
  if (extra.experimental !== false) await call(host, "PUT", "/api/settings", { experimentalFeatures: ["agy"] });
  return host;
}

async function call<T>(host: RunningHost, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${host.info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T;
  if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = (host: RunningHost) => call<StateSnapshot>(host, "GET", "/api/state");
const items = (host: RunningHost, id: string) => call<SessionItem[]>(host, "GET", `/api/sessions/${id}/items`);
const status = async (host: RunningHost, id: string) => (await state(host)).sessions.find((s) => s.id === id)?.status;
const replies = (list: SessionItem[]) => list.filter((i) => i.type === "agent").map((i) => (i.type === "agent" ? i.markdown : ""));
const idle = (host: RunningHost, id: string) => until(() => status(host, id), (s) => s === "idle");
const lastReply = async (host: RunningHost, id: string, n: number) => replies(await until(() => items(host, id), (l) => replies(l).length >= n)).at(n - 1);

async function start(host: RunningHost, text: string, options: Record<string, unknown> = {}): Promise<Session> {
  const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
  const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "Gemini 任务", workspaceId: ws.id, firstSession: { profileId: AGY_PROFILE_ID, text, options } });
  return session;
}

async function send(host: RunningHost, id: string, text: string): Promise<void> {
  await call(host, "POST", `/api/sessions/${id}/messages`, { text });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-agy-"));
  dataDir = join(root, "data");
  mkdirSync(join(root, "ws"));
});

afterEach(async () => {
  for (const h of running.splice(0)) await h.shutdown();
  removeTempDir(root);
});

describe("agy runtime", () => {
  it("offers Gemini only while its 测试功能 is on", async () => {
    const host = await boot({ experimental: false });
    expect((await state(host)).profiles.map((p) => p.id)).not.toContain(AGY_PROFILE_ID);
    await call(host, "PUT", "/api/settings", { experimentalFeatures: ["agy"] });
    expect((await state(host)).profiles.map((p) => p.id)).toContain(AGY_PROFILE_ID);
    await call(host, "PUT", "/api/settings", { experimentalFeatures: [] });
    expect((await state(host)).profiles.map((p) => p.id)).not.toContain(AGY_PROFILE_ID);
  });

  it("runs a turn, keeps Google's variables from agy and turns its updater off", async () => {
    const host = await boot();
    const s = await start(host, "你好");
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(replies(list)).toEqual(["MOCK-AGY: 你好"]);
    expect(list.map((i) => i.type)).toEqual(["user", "turn", "reasoning", "agent"]);
    expect((await state(host)).sessions.find((x) => x.id === s.id)?.runtimeRef).toMatch(/^[0-9a-f-]{36}$/);
    await send(host, s.id, "[[env]]");
    expect(await lastReply(host, s.id, 2)).toBe("mode=accept-edits skip=false model=gemini-3.8-flash thought=high update=1 leaked=none");
  });

  it("maps the permissions: 只读 = plan, 完全访问 = a process with --dangerously-skip-permissions", async () => {
    const host = await boot();
    const s = await start(host, "[[env]]", { permission: "plan" });
    expect(await lastReply(host, s.id, 1)).toMatch(/^mode=plan skip=false /);
    await idle(host, s.id);
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { permission: "full-access" });
    await send(host, s.id, "[[env]]");
    expect(await lastReply(host, s.id, 2)).toMatch(/^mode=default skip=true /);
    await idle(host, s.id);
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { permission: "accept-edits" });
    await send(host, s.id, "[[env]]");
    expect(await lastReply(host, s.id, 3)).toMatch(/^mode=accept-edits skip=false /);
  });

  it("asks before a command; the answer goes back to agy", async () => {
    const host = await boot();
    const s = await start(host, "[[ask: dir]]");
    const pending = await until(() => items(host, s.id), (l) => l.some((i) => i.type === "approval" && i.state === "pending"));
    expect(await status(host, s.id)).toBe("awaiting-approval");
    const approval = pending.find((i) => i.type === "approval");
    // The command itself, though `dir` reads as a listing (its row says ".").
    expect(approval).toMatchObject({ kind: "command", summary: "dir" });
    await call(host, "POST", `/api/approvals/${approval?.type === "approval" ? approval.approvalId : ""}`, { sessionId: s.id, decision: "accept" });
    expect(await lastReply(host, s.id, 1)).toBe("MOCK-AGY: ran dir");
    await idle(host, s.id);
    await send(host, s.id, "[[ask: del x]]");
    const second = await until(() => items(host, s.id), (l) => l.filter((i) => i.type === "approval").length === 2 && l.some((i) => i.type === "approval" && i.state === "pending"));
    const next = second.find((i) => i.type === "approval" && i.state === "pending");
    await call(host, "POST", `/api/approvals/${next?.type === "approval" ? next.approvalId : ""}`, { sessionId: s.id, decision: "decline" });
    expect(await lastReply(host, s.id, 2)).toBe("MOCK-AGY: not allowed");
  });

  it("lets AMO's own tools through, but asks for the writes the person approves first", async () => {
    const host = await boot();
    const s = await start(host, "[[mcp: task_get]]");
    expect(await lastReply(host, s.id, 1)).toBe("MOCK-AGY: task_get allowed");
    expect((await items(host, s.id)).some((i) => i.type === "approval")).toBe(false);
    await idle(host, s.id);
    await send(host, s.id, "[[mcp: project_add]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "approval" && i.state === "pending"));
  });

  it("gives agy the AMO MCP over HTTP", async () => {
    const host = await boot();
    const s = await start(host, "[[mcp-list]]");
    expect(await lastReply(host, s.id, 1)).toBe("mcp=amo:http");
  });

  it("offers Gemini with its thinking levels; other models only once turned on in 设置", async () => {
    const host = await boot();
    const s = await start(host, "你好");
    await idle(host, s.id);
    const choices = await call<ProfileChoices>(host, "GET", `/api/profiles/${AGY_PROFILE_ID}/choices`);
    expect(choices.models.map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
    expect(choices.models[0]).toMatchObject({ efforts: ["low", "medium", "high"], isDefault: true });
    expect(choices.permissions.map((p) => p.id)).toEqual(["accept-edits", "plan", "full-access"]);
    const st = await call<AgyStatus>(host, "PUT", "/api/agy", { extraModels: ["claude-sonnet-4-6"] });
    expect(st.offered.map((m) => m.id)).toEqual(["gemini-3.8-flash", "claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    const more = await call<ProfileChoices>(host, "GET", `/api/profiles/${AGY_PROFILE_ID}/choices`);
    expect(more.models.map((m) => m.id)).toEqual(["gemini-3.8-flash", "claude-sonnet-4-6"]);
    expect(more.models[1]!.efforts).toEqual([]);
    // A model and a level picked for the session reach agy.
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { model: "gemini-3.8-flash", effort: "low" });
    await send(host, s.id, "[[env]]");
    expect(await lastReply(host, s.id, 2)).toMatch(/ model=gemini-3.8-flash thought=low /);
    await idle(host, s.id);
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { model: "claude-sonnet-4-6" });
    await send(host, s.id, "[[env]]");
    expect(await lastReply(host, s.id, 3)).toMatch(/ model=claude-sonnet-4-6 /);
  });

  it("cancels a running turn with 停止", async () => {
    const host = await boot();
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await until(() => status(host, s.id), (x) => x !== "running");
    const turn = (await items(host, s.id)).find((i) => i.type === "turn");
    expect(turn?.type === "turn" ? turn.state : null).toBe("interrupted");
  });

  it("goes on in a new agy process after the Host restarts (session/resume)", async () => {
    let host = await boot();
    const s = await start(host, "第一句");
    await idle(host, s.id);
    await host.shutdown();
    running.splice(running.indexOf(host), 1);
    host = await boot();
    await send(host, s.id, "第二句");
    expect(await lastReply(host, s.id, 2)).toBe("MOCK-AGY: 第二句");
  });

  it("refuses to fork", async () => {
    const host = await boot();
    const s = await start(host, "你好");
    await idle(host, s.id);
    await expect(call(host, "POST", `/api/sessions/${s.id}/fork`, {})).rejects.toThrow(/Gemini 会话不能分支/);
  });

  it("「检查」 says when agy needs a sign-in, and 「登录」 signs it in", async () => {
    const host = await boot({ env: { FAKE_AGY_NEEDS_LOGIN: "1" } });
    const before = await call<AgyStatus>(host, "POST", "/api/agy/check");
    expect(before.check).toMatchObject({ ok: false, needsLogin: true });
    const st = await call<AgyStatus>(host, "POST", "/api/agy/login");
    expect(st.login?.state).toBe("running");
    const after = await until(() => call<AgyStatus>(host, "GET", "/api/agy"), (x) => x.login?.state === "done" && !!x.check?.ok);
    expect(after.check?.message).toMatch(/^可用 · ACP 1 · /);
    expect(after.offered.length).toBe(3);
  });
});
