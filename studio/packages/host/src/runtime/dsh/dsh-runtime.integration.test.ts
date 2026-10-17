import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DshStatus, ModelProfile, ProfileChoices, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { fakeAcpAgent, removeTempDir } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../credentials.js";

// DSH sessions (stage 17) through a whole Host, with the scripted ACP agent standing in for `dsh --profile acp`.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "dsh-deepseek", label: "DeepSeek", runtime: "dsh", provider: "deepseek-official", model: null, credentialId: "deepseek-v4" },
];

let root: string;
let dataDir: string;
const running: RunningHost[] = [];

async function boot(): Promise<RunningHost> {
  const servers = new FakeServers(PROFILES.filter((p) => p.runtime === "codex"));
  const host = await startHost({
    dataDir,
    port: 0,
    profiles: PROFILES,
    servers: Object.assign(servers, { stopAll: () => servers.close() }),
    credentials: new StaticCredentialReader({ "deepseek-v4": "sk-test" }),
    dshAgent: fakeAcpAgent(),
  });
  running.push(host);
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

const items = (host: RunningHost, id: string) => call<SessionItem[]>(host, "GET", `/api/sessions/${id}/items`);
const status = async (host: RunningHost, id: string) => (await call<StateSnapshot>(host, "GET", "/api/state")).sessions.find((s) => s.id === id)?.status;
const replies = (list: SessionItem[]) => list.filter((i) => i.type === "agent").map((i) => (i.type === "agent" ? i.markdown : ""));
const idle = (host: RunningHost, id: string) => until(() => status(host, id), (s) => s === "idle");

async function start(host: RunningHost, text: string): Promise<Session> {
  const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
  const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "DSH 任务", workspaceId: ws.id, firstSession: { profileId: "dsh-deepseek", text } });
  return session;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-dsh-"));
  dataDir = join(root, "data");
  mkdirSync(join(root, "ws"));
});

afterEach(async () => {
  for (const h of running.splice(0)) await h.shutdown();
  removeTempDir(root);
});

describe("DSH runtime", () => {
  it("runs a turn: thought, reply, context use; the process gets its own home, the key and the permission mode", async () => {
    const host = await boot();
    const s = await start(host, "你好 [[context: 4321]]");
    expect(s.runtime).toBe("dsh");
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.map((i) => i.type)).toEqual(["user", "turn", "reasoning", "agent"]);
    expect(replies(list)).toEqual(["MOCK-DSH: 你好 [[context: 4321]]"]);
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "completed", usage: { context: 4321, contextWindow: 1_000_000 } });

    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[env]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toMatch(/^ENV permission=workspace-write key=yes home=yes /);
  });

  it("asks before a command leaves the sandbox; allowed it runs, declined it does not", async () => {
    const host = await boot();
    const s = await start(host, "[[ask: New-Item a.txt]]");
    await until(() => status(host, s.id), (v) => v === "awaiting-approval");
    let approval = (await items(host, s.id)).find((i) => i.type === "approval");
    expect(approval).toMatchObject({ kind: "command", summary: "New-Item a.txt", state: "pending" });
    expect(approval?.type === "approval" && approval.detail).toContain("the person asked for it");
    await call(host, "POST", `/api/approvals/${approval?.type === "approval" ? approval.approvalId : ""}`, { sessionId: s.id, decision: "accept" });
    await idle(host, s.id);
    expect(replies(await items(host, s.id))).toEqual(["DONE New-Item a.txt"]);

    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[ask: Remove-Item a.txt]]" });
    await until(() => status(host, s.id), (v) => v === "awaiting-approval");
    approval = (await items(host, s.id)).filter((i) => i.type === "approval").at(-1);
    await call(host, "POST", `/api/approvals/${approval?.type === "approval" ? approval.approvalId : ""}`, { sessionId: s.id, decision: "decline" });
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(replies(list).at(-1)).toBe("REJECTED Remove-Item a.txt");
    expect(list.filter((i) => i.type === "approval").map((i) => (i.type === "approval" ? i.state : ""))).toEqual(["accepted", "declined"]);
  });

  it("queues a message sent while a turn runs; stopping ends the turn and drops the queue", async () => {
    const host = await boot();
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    const sent = await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/messages`, { text: "还有一件事" });
    expect(sent.mode).toBe("queue");
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "interrupted" });
    expect(list.find((i) => i.type === "tool")).toMatchObject({ status: "failed" });
    expect(list.some((i) => i.type === "notice" && i.message.includes("排队的 1 条消息没有发出"))).toBe(true);

    // A queued message is sent once the turn ends.
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[ask: x]]" });
    await until(() => status(host, s.id), (v) => v === "awaiting-approval");
    expect((await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/messages`, { text: "接着说" })).mode).toBe("queue");
    const approval = (await items(host, s.id)).filter((i) => i.type === "approval").at(-1);
    await call(host, "POST", `/api/approvals/${approval?.type === "approval" ? approval.approvalId : ""}`, { sessionId: s.id, decision: "accept" });
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 接着说"));
    await idle(host, s.id);
  });

  it("gives the AMO MCP with the role card in its instructions, and without the writes the person approves first", async () => {
    const host = await boot();
    const s = await start(host, "[[mcp: amo_whoami]]");
    await idle(host, s.id);
    const reply = replies(await items(host, s.id))[0]!;
    expect(reply).toContain("MCP RESULT");
    expect(reply).toContain("DSH 任务");
    expect(reply).toMatch(/INSTRUCTIONS [\s\S]*DSH 任务/);
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[mcp: canvas_place]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toContain("NO TOOL canvas_place");
  });

  it("resumes the DSH session after a Host restart; model, effort and permission go to DSH", async () => {
    let host = await boot();
    const s = await start(host, "第一句");
    await idle(host, s.id);
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { model: "deepseek-official/deepseek-v4-pro", effort: "max", permission: "read-only" });
    await running.pop()!.shutdown();

    host = await boot();
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[env]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toBe('ENV permission=read-only key=yes home=yes model=["deepseek-official","deepseek-v4-pro"] effort=max');
    await idle(host, s.id);
  });

  it("offers DSH's models and efforts and its permission settings; refuses images, fork and the terminal; 检查 works", async () => {
    const host = await boot();
    const checked = await call<DshStatus>(host, "POST", "/api/dsh/check");
    expect(checked.check).toMatchObject({ ok: true, message: "可用 · ACP 1 · 2 个型号" });
    const choices = await call<ProfileChoices>(host, "GET", "/api/profiles/dsh-deepseek/choices");
    expect(choices.models.map((m) => m.label)).toEqual(["deepseek-v4-flash", "DeepSeek-V4-Pro"]);
    expect(choices.models[0]).toMatchObject({ isDefault: true, efforts: ["off", "low", "high", "max"], defaultEffort: "high" });
    expect(choices.permissions.map((p) => p.id)).toEqual(["workspace-write", "read-only", "full-access"]);
    expect(choices.defaultPermission).toBe("workspace-write");

    const s = await start(host, "hi");
    await idle(host, s.id);
    await expect(call(host, "POST", `/api/sessions/${s.id}/fork`, {})).rejects.toThrow(/不能分支/);
    await expect(call(host, "POST", `/api/sessions/${s.id}/terminal`, { launch: false })).rejects.toThrow(/不能在终端打开/);
  });

  it("fails a turn when DSH fails it", async () => {
    const host = await boot();
    const s = await start(host, "[[fail]]");
    await until(() => status(host, s.id), (v) => v === "error");
    const list = await items(host, s.id);
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "failed" });
    expect(list.find((i) => i.type === "error")).toMatchObject({ message: expect.stringContaining("fake failure") });
  });
});
