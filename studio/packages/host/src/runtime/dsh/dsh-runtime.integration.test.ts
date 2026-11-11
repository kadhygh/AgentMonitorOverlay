import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialStatus, DshStatus, ModelProfile, ProfileChoices, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { fakeAcpAgent, removeTempDir, TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../credentials.js";
import type { FolderAccess } from "./folder-access.js";
import { AcpError } from "./acp.js";
import { failingMcpOf } from "./dsh-runtime.js";

// DSH sessions (stage 17) through a whole Host, with the scripted ACP agent standing in for `dsh --profile acp`.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "dsh-deepseek", label: "DeepSeek", runtime: "dsh", provider: "deepseek-official", model: null, credentialId: "deepseek-v4" },
];

let root: string;
let dataDir: string;
const running: RunningHost[] = [];

async function boot(extra: Partial<Parameters<typeof startHost>[0]> = {}): Promise<RunningHost> {
  const servers = new FakeServers(PROFILES.filter((p) => p.runtime === "codex"));
  const host = await startHost({
    dataDir,
    port: 0,
    profiles: PROFILES,
    servers: Object.assign(servers, { stopAll: () => servers.close() }),
    credentials: new StaticCredentialReader({ "deepseek-v4": "sk-test" }),
    dshAgent: fakeAcpAgent(),
    ...extra,
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
const userRow = (list: SessionItem[], text: string) => list.find((i): i is Extract<SessionItem, { type: "user" }> => i.type === "user" && i.text === text);

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

/** The person's own DSH home (where the desktop app keeps its sign-in); some tests point it at their own. */
const DSH_HOME = process.env.DSH_HOME;

afterEach(async () => {
  for (const h of running.splice(0)) await h.shutdown();
  if (DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = DSH_HOME;
  removeTempDir(root);
});

describe("DSH runtime", () => {
  it("shows a subagent DSH starts itself as a child session filled from its log, while it runs (2026-11-06)", async () => {
    const host = await boot();
    const s = await start(host, "[[subagent: 1500]]");
    const sessions = async () => (await call<StateSnapshot>(host, "GET", "/api/state")).sessions;
    const child = await until(async () => (await sessions()).find((x) => x.parentId === s.id), (c) => !!c);
    expect(child).toMatchObject({ kind: "sub", runtime: "dsh", title: "数文件" });
    // While it runs: its command shows in its own session, before the parent's turn is over.
    const running = await until(() => items(host, child!.id), (l) => l.some((i) => i.type === "tool" && i.input === "Get-ChildItem src"));
    expect(await status(host, s.id)).toBe("running");
    expect((await sessions()).find((x) => x.id === child!.id)?.status).toBe("running");
    expect(running.find((i) => i.type === "user")).toMatchObject({ text: "数一数 src 下的文件" });
    await idle(host, s.id);
    const done = await until(() => items(host, child!.id), (l) => l.some((i) => i.type === "turn" && i.state === "completed"));
    expect((await sessions()).find((x) => x.id === child!.id)).toMatchObject({ status: "completed", runtimeRef: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(done.map((i) => i.type)).toEqual(["user", "turn", "reasoning", "tool", "agent"]);
    expect(done.find((i) => i.type === "tool")).toMatchObject({ kind: "list", status: "completed", detail: "a.ts\nb.ts" });
    expect(replies(done)).toEqual(["共 2 个文件"]);
    expect(done.find((i) => i.type === "turn")).toMatchObject({ usage: { input: 100, output: 50 } });
    // The parent: a ▸ row (no tool row), what the agent sent back, and its own reply.
    const parent = await items(host, s.id);
    expect(parent.filter((i) => i.type === "tool")).toEqual([]);
    expect(parent.find((i) => i.type === "subagent")).toMatchObject({ childSessionId: child!.id, summary: "数文件", usage: { input: 100, output: 50 } });
    expect(parent.find((i) => i.type === "notice")).toMatchObject({ message: "子 agent「数文件」发回了消息：共 2 个文件" });
    expect(replies(parent).at(-1)).toMatch(/^SUB DONE /);
    // It takes no messages of its own.
    await expect(call(host, "POST", `/api/sessions/${child!.id}/messages`, { text: "你好" })).rejects.toThrow(/409.*子 agent 不能单独接收消息/);
  });

  it("shows why a subagent's turn failed as an error row of its session, as a main session's failed turn has (2026-11-07)", async () => {
    const host = await boot();
    const s = await start(host, "[[subagent: 300 fail]]");
    const child = await until(async () => (await call<StateSnapshot>(host, "GET", "/api/state")).sessions.find((x) => x.parentId === s.id), (c) => !!c);
    await idle(host, s.id);
    const list = await until(() => items(host, child!.id), (l) => l.some((i) => i.type === "turn" && i.state === "failed"));
    expect(list.find((i) => i.type === "error")).toMatchObject({ message: "DeepSeek Messages stream ended before message_stop（STREAM_CLOSED）" });
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "failed", error: "DeepSeek Messages stream ended before message_stop（STREAM_CLOSED）" });
    expect((await call<StateSnapshot>(host, "GET", "/api/state")).sessions.find((x) => x.id === child!.id)?.status).toBe("error");
  });

  it("fills in the tokens and speed of turns that ended without them, from DSH's log, without touching others (2026-10-27)", async () => {
    const host = await boot();
    const s = await start(host, "你好");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "turn" && !!i.decode));
    // As every DSH turn was before 10-27: ended, no tokens, no speed.
    const store = host.service.store;
    const turn = store.findItems(s.id, "turn")[0]!;
    if (turn.type !== "turn") throw new Error("not a turn");
    const { decode: _decode, ...bare } = turn;
    store.replaceItem({ ...bare, usage: { ...turn.usage!, input: 0, cachedInput: 0, output: 0 } });
    const dsh = host.service.options.dsh!;
    expect(await dsh.backfillStats(0)).toBe(1);
    expect(store.findItems(s.id, "turn")[0]).toMatchObject({ decode: { ms: 2000, tokens: 400 }, usage: { input: 1300, cachedInput: 1000, output: 400 } });
    // Nothing left to fill: the log is not read again.
    expect(await dsh.backfillStats(0)).toBe(0);
  });

  it("runs a turn: thought, reply, context use; the process gets its own home, the key and the permission mode", async () => {
    const host = await boot();
    const s = await start(host, "你好 [[context: 4321]]");
    expect(s.runtime).toBe("dsh");
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.map((i) => i.type)).toEqual(["user", "turn", "reasoning", "agent"]);
    expect(replies(list)).toEqual(["MOCK-DSH: 你好 [[context: 4321]]"]);
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "completed", usage: { context: 4321, contextWindow: 1_000_000 } });
    // Tokens and speed from DSH's own log (ACP has only the context size): 400 output tokens over 2 s.
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "turn" && !!i.decode));
    expect((await items(host, s.id)).find((i) => i.type === "turn")).toMatchObject({ decode: { ms: 2000, tokens: 400 }, usage: { input: 1300, cachedInput: 1000, output: 400, context: 4321 } });

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

  it("makes what a DSH goal does by itself after the prompt turns of their own: running meanwhile, one per round, each ended after its reply (问题 #13)", async () => {
    const host = await boot({ dshAutoQuietMs: 400 });
    const s = await start(host, "做到底 [[goal: 2]]");
    await until(() => items(host, s.id), (l) => replies(l).includes("ROUND 1 DONE"));
    expect(await status(host, s.id)).toBe("running");
    await until(() => items(host, s.id), (l) => replies(l).includes("ROUND 2 DONE"));
    await idle(host, s.id);
    const list = await items(host, s.id);
    const turns = list.filter((i) => i.type === "turn");
    expect(turns.map((t) => (t.type === "turn" ? t.state : ""))).toEqual(["completed", "completed", "completed"]);
    // Every row has its turn; each round's reply is the last row of its own.
    expect(list.filter((i) => i.type !== "user" && i.type !== "turn").every((i) => !!i.raw?.turnId)).toBe(true);
    const repliesOf = (t: SessionItem) => replies(list.filter((i) => t.type === "turn" && i.raw?.turnId === t.turnId));
    expect(turns.map(repliesOf)).toEqual([["MOCK-DSH: 做到底 [[goal: 2]]"], ["ROUND 1 DONE"], ["ROUND 2 DONE"]]);
  });

  it("停止 stops a DSH goal going on by itself; a message sent meanwhile ends that turn and starts the person's (问题 #13)", async () => {
    const host = await boot({ dshAutoQuietMs: 400 });
    const s = await start(host, "做 [[goal: 1 slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    expect(await status(host, s.id)).toBe("running");
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await idle(host, s.id);
    let list = await items(host, s.id);
    expect(list.filter((i) => i.type === "turn").map((t) => (t.type === "turn" ? t.state : ""))).toEqual(["completed", "interrupted"]);
    // DSH's last update while stopping (the call aborted) stays in the stopped turn.
    expect(list.find((i) => i.type === "tool")).toMatchObject({ status: "failed" });

    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "再来 [[goal: 1 slow]]" });
    await until(() => items(host, s.id), (l) => l.filter((i) => i.type === "tool").length === 2 && l.filter((i) => i.type === "turn").length === 4);
    expect((await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/messages`, { text: "先停一下" })).mode).toBe("start");
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 先停一下"));
    await idle(host, s.id);
    list = await items(host, s.id);
    expect(list.filter((i) => i.type === "turn").map((t) => (t.type === "turn" ? t.state : ""))).toEqual(["completed", "interrupted", "completed", "completed", "completed"]);
  });

  it("queues a message sent while a turn runs (waiting); 停止 ends the turn and the message goes on as the next (2026-11-04)", async () => {
    const host = await boot();
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    const sent = await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/messages`, { text: "还有一件事" });
    expect(sent.mode).toBe("queue");
    expect(userRow(await items(host, s.id), "还有一件事")).toMatchObject({ delivery: "waiting" });
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 还有一件事"));
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.filter((i) => i.type === "turn").map((t) => (t.type === "turn" ? t.state : ""))).toEqual(["interrupted", "completed"]);
    expect(list.find((i) => i.type === "tool")).toMatchObject({ status: "failed" });
    expect(userRow(list, "还有一件事")?.delivery).toBeUndefined();

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

  it("gives the session's other MCP servers (Studio's and the person's), and a change from its next message", async () => {
    // The person's Claude Code config, in a dir of the test's own (the Host never reads the real ~/.claude.json here).
    const claudeDir = join(root, "claude-local");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" }, "amo-relay": { command: "node" } } }));
    const host = await boot({ localClaudeHome: claudeDir });
    await call(host, "POST", "/api/mcp/servers", { name: "img", spec: { command: "npx", args: ["img-mcp"], env: { KEY: "k" } } });
    // An SSE server DSH does not take (2026-11-09: it refused the whole session): left out, and the session says so.
    await call(host, "POST", "/api/mcp/servers", { name: "canvas", spec: { type: "sse", url: "https://canvas.example/api/mcp/sse" } });
    const s = await start(host, "[[mcp-list]]");
    await idle(host, s.id);
    expect(replies(await items(host, s.id))[0]).toBe("MCP-LIST amo:http,figma:http,img:stdio");
    const told = (await items(host, s.id)).filter((i) => i.type === "notice" && i.message.includes("没带上 MCP"));
    expect(told.map((i) => (i.type === "notice" ? i.message : ""))).toEqual([expect.stringContaining("canvas（SSE 连接）。DeepSeek 不支持这种连接方式")]);
    const changed = await call<{ apply: string; entries: Array<{ name: string; on: boolean }> }>(host, "PUT", `/api/sessions/${s.id}/mcp`, { choices: { figma: false, "amo-relay": true } });
    expect(changed.apply).toBe("next-message");
    expect(Object.fromEntries(changed.entries.map((e) => [e.name, e.on]))).toMatchObject({ figma: false, "amo-relay": true, img: true });
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[mcp-list]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toBe("MCP-LIST amo:http,amo-relay:stdio,img:stdio");
    // Its process started again (the change), still without canvas: not said a second time.
    expect((await items(host, s.id)).filter((i) => i.type === "notice" && i.message.includes("没带上 MCP"))).toHaveLength(1);
  });

  it("leaves out a server DSH cannot connect to, instead of having no session (2026-11-09, ybf: Figma's MCP →「Internal error」)", async () => {
    const host = await boot();
    await call(host, "POST", "/api/mcp/servers", { name: "img", spec: { command: "npx", args: ["img-mcp"] } });
    await call(host, "POST", "/api/mcp/servers", { name: "figma", spec: { type: "http", url: "https://unreachable.example/mcp" } });
    const s = await start(host, "[[mcp-list]]");
    await idle(host, s.id);
    expect(replies(await items(host, s.id))[0]).toBe("MCP-LIST amo:http,img:stdio");
    const told = (await items(host, s.id)).filter((i) => i.type === "notice" && i.message.includes("没带上 MCP"));
    expect(told.map((i) => (i.type === "notice" ? i.message : ""))).toEqual([expect.stringContaining("figma（initial connection or tool synchronization failed）。DeepSeek 连不上它")]);
    // Another MCP choice starts its process again (session/resume): still without figma, and not said again.
    await call(host, "PUT", `/api/sessions/${s.id}/mcp`, { choices: { img: false } });
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[mcp-list]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toBe("MCP-LIST amo:http");
    expect((await items(host, s.id)).filter((i) => i.type === "notice" && i.message.includes("没带上 MCP"))).toHaveLength(1);
  });

  it("says what DSH said failed, not only「Internal error」", () => {
    const err = new AcpError("Internal error", -32603, { details: "mcp-client(figma): initial connection or tool synchronization failed" });
    expect(failingMcpOf(err, ["figma"])).toEqual({ name: "figma", why: "initial connection or tool synchronization failed" });
    expect(failingMcpOf(err, ["img"])).toBeNull();
    expect(failingMcpOf(new Error("x"), ["figma"])).toBeNull();
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

  it("offers DSH's models and efforts and its permission settings; refuses fork and the terminal; 检查 works", async () => {
    const host = await boot();
    const checked = await call<DshStatus>(host, "POST", "/api/dsh/check");
    expect(checked.check).toMatchObject({ ok: true, message: "可用 · ACP 1 · 3 个型号" });
    const choices = await call<ProfileChoices>(host, "GET", "/api/profiles/dsh-deepseek/choices");
    expect(choices.models.map((m) => m.label)).toEqual(["deepseek-v4-flash", "DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro"]);
    expect(choices.models[0]).toMatchObject({ isDefault: true, efforts: ["off", "low", "high", "max"], defaultEffort: "high" });
    expect(choices.permissions.map((p) => p.id)).toEqual(["workspace-write", "read-only", "full-access"]);
    expect(choices.defaultPermission).toBe("workspace-write");

    const s = await start(host, "hi");
    await idle(host, s.id);
    await expect(call(host, "POST", `/api/sessions/${s.id}/fork`, {})).rejects.toThrow(/不能分支/);
    await expect(call(host, "POST", `/api/sessions/${s.id}/terminal`, { launch: false })).rejects.toThrow(/不能在终端打开/);
  });

  it("sends images when the session's model takes them; another model is refused by name; switching models restarts the process on the new one (2026-10-26)", async () => {
    const host = await boot();
    const upload = async () => {
      const res = await fetch(`${host.info.url}/api/attachments?name=shot.png&type=image/png`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "image/png" }, body: Buffer.from(TINY_PNG_BASE64, "base64") });
      return ((await res.json()) as { id: string }).id;
    };
    // DSH's default model here takes no images: refused with its name, nothing shown or sent.
    const s = await start(host, "hi");
    await idle(host, s.id);
    const before = (await items(host, s.id)).length;
    await expect(call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "看图", attachments: [await upload()] })).rejects.toThrow(/「deepseek-v4-flash」不收图片；点输入框下面的型号（Alt M）换成「DeepSeek-V4.1-Flash」再发/);
    expect((await items(host, s.id)).length).toBe(before);

    // Switched to V4.1-Flash: the process starts again on it, DSH offers images, the picture goes with the text.
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { model: "deepseek-official/deepseek-flash" });
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "看图", attachments: [await upload()] });
    await until(() => items(host, s.id), (l) => replies(l).some((r) => r.includes("看图 [1 张图 image/png]")));
    const shown = (await items(host, s.id)).filter((i) => i.type === "user").at(-1);
    expect(shown?.type === "user" && shown.images?.length).toBe(1);

    // A new session on V4.1-Flash takes images from its first message on.
    const { session: f } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", {
      title: "看图任务",
      workspaceId: s.workspaceId,
      firstSession: { profileId: "dsh-deepseek", text: "第一句带图", options: { model: "deepseek-official/deepseek-flash" }, attachments: [await upload()] },
    });
    await until(() => items(host, f.id), (l) => replies(l).some((r) => r.includes("第一句带图 [1 张图 image/png]")));
  });

  it("a channel's own model names keep DSH's word that deepseek-flash takes images, and the process starts on the session's model (2026-11-11)", async () => {
    // The person's 「Dxx-DS」: DeepSeek-V4.1-Flash was refused every picture — the catalog patch listed `deepseek-flash`
    // without `inputModalities` (text only in DSH), and the agent always started on the channel's first model.
    const host = await boot();
    const upload = async () => {
      const res = await fetch(`${host.info.url}/api/attachments?name=shot.png&type=image/png`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "image/png" }, body: Buffer.from(TINY_PNG_BASE64, "base64") });
      return ((await res.json()) as { id: string }).id;
    };
    const channel = await call<{ id: string }>(host, "POST", "/api/channels", { kind: "dsh", label: "Dxx-DS", baseUrl: "https://relay.example", key: "sk-relay", models: ["deepseek-v4-flash", "deepseek-flash"] });
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "中转看图", workspaceId: ws.id, firstSession: { profileId: channel.id, text: "hi" } });
    await idle(host, session.id);
    // On the channel's first model (text only): refused, pointing at the one of its names that takes images.
    await expect(call(host, "POST", `/api/sessions/${session.id}/messages`, { text: "看图", attachments: [await upload()] })).rejects.toThrow(/「deepseek-v4-flash」不收图片；点输入框下面的型号（Alt M）换成「deepseek-flash（DeepSeek-V4.1-Flash）」再发/);
    await call(host, "PATCH", `/api/sessions/${session.id}/options`, { model: "deepseek-official/deepseek-flash" });
    await call(host, "POST", `/api/sessions/${session.id}/messages`, { text: "看图", attachments: [await upload()] });
    await until(() => items(host, session.id), (l) => replies(l).some((r) => r.includes("看图 [1 张图 image/png]")));

    // A relay's own name for V4.1-Flash is text only to DSH until the channel says it takes images (its 能看图).
    const relay = await call<{ id: string; imageModels?: string[] }>(host, "POST", "/api/channels", { kind: "dsh", label: "中转 V4.1", baseUrl: "https://relay.example", key: "sk-relay", models: ["deepseek/v4.1-flash"] });
    expect(relay.imageModels).toEqual([]);
    const { session: t } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "中转 V4.1", workspaceId: ws.id, firstSession: { profileId: relay.id, text: "hi" } });
    await idle(host, t.id);
    await expect(call(host, "POST", `/api/sessions/${t.id}/messages`, { text: "看图", attachments: [await upload()] })).rejects.toThrow(/「中转 V4.1」的型号都没标「能看图」.*设置 → 模型 →「中转 V4.1」→ 编辑，在「能看图」那一行点亮/);
    // Marked while the session's process is still up: the next picture starts it again on the new catalog.
    const marked = await call<{ imageModels?: string[] }>(host, "PATCH", `/api/channels/${relay.id}`, { imageModels: ["deepseek/v4.1-flash", "not-listed"] });
    expect(marked.imageModels).toEqual(["deepseek/v4.1-flash"]);
    await call(host, "POST", `/api/sessions/${t.id}/messages`, { text: "看图二", attachments: [await upload()] });
    await until(() => items(host, t.id), (l) => replies(l).some((r) => r.includes("看图二 [1 张图 image/png]")));
    // deepseek-flash can be put out too: what the person says counts.
    const out = await call<{ imageModels?: string[] }>(host, "PATCH", `/api/channels/${channel.id}`, { imageModels: [] });
    expect(out.imageModels).toEqual([]);
    await idle(host, session.id);
    await expect(call(host, "POST", `/api/sessions/${session.id}/messages`, { text: "看图", attachments: [await upload()] })).rejects.toThrow(/「Dxx-DS」的型号都没标「能看图」/);
  });

  it("runs a third-party DeepSeek channel: its address, its own key and its model (2026-10-19)", async () => {
    const host = await boot();
    const channel = await call<{ id: string; kind: string }>(host, "POST", "/api/channels", {
      kind: "dsh",
      label: "中转 DeepSeek",
      baseUrl: "https://relay.example/anthropic",
      key: "sk-relay",
      model: "deepseek-v4-pro",
    });
    expect(channel.kind).toBe("dsh");
    const profiles = (await call<StateSnapshot>(host, "GET", "/api/state")).profiles;
    expect(profiles.find((p) => p.id === channel.id)).toMatchObject({ runtime: "dsh", label: "中转 DeepSeek", custom: true, model: "deepseek-official/deepseek-v4-pro" });
    // The built-in DeepSeek keeps DeepSeek's own address and key.
    const own = await start(host, "[[endpoint]]");
    await until(() => items(host, own.id), (l) => replies(l).length === 1);
    expect(replies(await items(host, own.id))[0]).toMatch(/^ENDPOINT base= key=sk-test /);
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "中转", workspaceId: own.workspaceId, firstSession: { profileId: channel.id, text: "[[endpoint]]" } });
    await until(() => items(host, session.id), (l) => replies(l).length === 1);
    expect(replies(await items(host, session.id))[0]).toBe('ENDPOINT base=https://relay.example/anthropic key=sk-relay model=["deepseek-official","deepseek-v4-pro"]');
  });

  it("a DSH channel with the site's own model names: DSH gets them as its catalog, the pickers offer them (2026-10-19)", async () => {
    const host = await boot();
    await call(host, "POST", "/api/dsh/check");
    const channel = await call<{ id: string; models: string[] }>(host, "POST", "/api/channels", {
      kind: "dsh",
      label: "中转 DeepSeek",
      baseUrl: "https://relay.example",
      key: "sk-relay",
      models: ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
    });
    expect(channel.models).toEqual(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"]);
    const choices = await call<ProfileChoices>(host, "GET", `/api/profiles/${channel.id}/choices`);
    expect(choices.models.map((m) => [m.id, m.isDefault ?? false])).toEqual([
      ["deepseek-official/deepseek/deepseek-v4.1-flash", true],
      ["deepseek-official/deepseek/deepseek-v4-pro", false],
    ]);
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "中转", workspaceId: ws.id, firstSession: { profileId: channel.id, text: "[[endpoint]]" } });
    await until(() => items(host, session.id), (l) => replies(l).length === 1);
    expect(replies(await items(host, session.id))[0]).toBe('ENDPOINT base=https://relay.example key=sk-relay model=["deepseek-official","deepseek/deepseek-v4.1-flash"]');
    // Another of its names (the fake, like DSH, refuses a model it does not offer).
    await call(host, "PATCH", `/api/sessions/${session.id}/options`, { model: "deepseek-official/deepseek/deepseek-v4-pro" });
    await call(host, "POST", `/api/sessions/${session.id}/messages`, { text: "[[endpoint]]" });
    await until(() => items(host, session.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, session.id))[1]).toBe('ENDPOINT base=https://relay.example key=sk-relay model=["deepseek-official","deepseek/deepseek-v4-pro"]');
    // The built-in DeepSeek still offers DSH's own models.
    const builtin = await call<ProfileChoices>(host, "GET", "/api/profiles/dsh-deepseek/choices");
    expect(builtin.models.map((m) => m.label)).toEqual(["deepseek-v4-flash", "DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro"]);
  });

  it("完全访问 chosen mid-turn counts at once (what waits is granted, and what DSH asks after), and the process restarts with it once the turn ends (2026-10-19, 10-22)", async () => {
    const host = await boot();
    const s = await start(host, "[[ask: New-Item a.txt]]");
    await until(() => status(host, s.id), (v) => v === "awaiting-approval");
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { permission: "full-access" });
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "notice" && i.message.includes("已切到完全访问")));
    // Nobody answered: the waiting request was granted by the switch.
    await idle(host, s.id);
    expect((await items(host, s.id)).find((i) => i.type === "approval")).toMatchObject({ state: "accepted" });
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[env]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toMatch(/^ENV permission=danger-full-access key=yes /);
    // The same DSH session, resumed.
    expect(replies(await items(host, s.id))[0]).toBe("DONE New-Item a.txt");
    // DSH 0.2 keeps the permission a session started with, so it may still ask: Studio says yes.
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[ask: New-Item c.txt]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 3);
    expect(replies(await items(host, s.id))[2]).toBe("DONE New-Item c.txt");
    expect((await items(host, s.id)).filter((i) => i.type === "approval").every((i) => i.type === "approval" && i.state === "accepted")).toBe(true);
  });

  it("a stricter permission on a session that has started: it says DSH keeps the old one; the request still asks the person", async () => {
    const host = await boot();
    const s = await start(host, "[[ask: New-Item b.txt]]");
    await until(() => status(host, s.id), (v) => v === "awaiting-approval");
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { permission: "read-only" });
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "notice" && i.message.includes("收紧权限不会生效")));
    const approval = (await items(host, s.id)).find((i) => i.type === "approval");
    expect(approval).toMatchObject({ state: "pending" });
    await call(host, "POST", `/api/approvals/${approval?.type === "approval" ? approval.approvalId : ""}`, { sessionId: s.id, decision: "decline" });
    await idle(host, s.id);
    expect(replies(await items(host, s.id))[0]).toBe("REJECTED New-Item b.txt");
  });

  /** A stand-in for icacls: what was done, in order, and a folder state to read. */
  function fakeFolders(start: { ok: boolean; labelled: boolean } | null, exes = 3) {
    const done: string[] = [];
    let state = start;
    let hold: Promise<void> | null = null;
    let release: () => void = () => undefined;
    const folderAccess: FolderAccess = {
      check: async () => state,
      grant: async (folder) => {
        if (hold) await hold;
        done.push(`grant ${folder}`);
        state = { ok: true, labelled: state?.labelled ?? false };
        return "B.acl";
      },
      label: async (folder) => {
        done.push(`label ${folder}`);
        state = { ok: state?.ok ?? false, labelled: true };
      },
      exes: async (folder) => {
        if (hold) await hold;
        done.push(`exes ${folder}`);
        return exes;
      },
      revert: async (folder, granted) => {
        done.push(`revert ${folder}${granted ? " granted" : ""}`);
        state = { ok: !granted && (state?.ok ?? false), labelled: false };
        return "R.acl";
      },
    };
    return {
      folderAccess,
      done,
      /** The next grant or scan waits for `go()`. */
      pause: () => {
        hold = new Promise((r) => (release = r));
      },
      go: () => {
        hold = null;
        release();
      },
    };
  }

  it("DSH cannot set its write sandbox up on the folder: one notice offers to set it up, and follows the setup (2026-10-23)", async () => {
    const fake = fakeFolders(null);
    const host = await boot({ dshFolderAccess: fake.folderAccess });
    const session = await start(host, "[[nosandbox]]");
    await idle(host, session.id);
    const folder = (await call<StateSnapshot>(host, "GET", "/api/state")).workspaces.find((w) => w.id === session.workspaceId)!.path;
    const notices = (list: SessionItem[]) => list.filter((i) => i.type === "notice" && i.action?.kind === "folder-access") as Array<Extract<SessionItem, { type: "notice" }>>;
    // Unreadable at the start, so the notice comes from DSH's error alone; it repeats on every command: one row.
    let list = await until(() => items(host, session.id), (l) => notices(l).length > 0);
    expect(notices(list)).toHaveLength(1);
    expect(notices(list)[0]!.action).toEqual({ kind: "folder-access", path: folder, state: "offered" });
    await call(host, "POST", `/api/sessions/${session.id}/folder-access`);
    list = await until(() => items(host, session.id), (l) => notices(l)[0]?.action?.state === "failed");
    // It could not be read: nothing was changed.
    expect(fake.done).toEqual([]);
  });

  it("设置 lists every folder; 设置权限 grants, labels and sets the exes back; the session notice follows; 重新扫描 and the scan after a turn (2026-10-23)", async () => {
    const fake = fakeFolders({ ok: false, labelled: false });
    const host = await boot({ dshFolderAccess: fake.folderAccess, dshFolderScanMs: 0 });
    const session = await start(host, "你好");
    await idle(host, session.id);
    type Folders = { available: boolean; folders: Array<{ workspaceId: string; name: string; path: string; state: string; job?: string; fullControl?: boolean; exes?: number; backup?: string }> };
    const folders = () => call<Folders>(host, "GET", "/api/dsh/folders");
    const first = await folders();
    expect(first.available).toBe(true);
    // The common space is listed first, then the projects.
    expect(first.folders.map((f) => f.name)).toEqual(["公共目录", "ws"]);
    const mine = (f: Folders) => f.folders.find((x) => x.workspaceId === session.workspaceId)!;
    expect(mine(first)).toEqual(expect.objectContaining({ state: "unprepared", fullControl: false }));
    const path = mine(first).path;
    // The session's own check offered the setup too.
    const notice = async () => (await items(host, session.id)).find((i) => i.type === "notice" && i.action?.kind === "folder-access");
    await until(notice, (n) => n?.type === "notice" && n.action?.state === "offered");
    // A scan before the setup is refused.
    await expect(call(host, "POST", `/api/dsh/folders/${session.workspaceId}/scan`)).rejects.toThrow(/先「设置权限」/);

    fake.pause();
    const started = await call<{ state: string; job?: string }>(host, "POST", `/api/dsh/folders/${session.workspaceId}/fix`);
    expect(started).toEqual(expect.objectContaining({ state: "running", job: "setup" }));
    await until(notice, (n) => n?.type === "notice" && n.action?.state === "running");
    fake.go();
    const done = await until(folders, (f) => mine(f).state === "ready");
    expect(mine(done)).toEqual(expect.objectContaining({ exes: 3, backup: "B.acl", fullControl: true }));
    expect(fake.done).toEqual([`grant ${path}`, `label ${path}`, `exes ${path}`]);
    const fixed = await until(notice, (n) => n?.type === "notice" && n.action?.state === "done");
    expect(fixed?.type === "notice" && fixed.message).toContain("3 个 exe");
    expect((await call<{ state: string }>(host, "GET", `/api/dsh/folders/${session.workspaceId}`)).state).toBe("ready");

    // 重新扫描: the exes again, nothing else.
    await call(host, "POST", `/api/dsh/folders/${session.workspaceId}/scan`);
    await until(() => fake.done.length, (n) => n === 4);
    expect(fake.done[3]).toBe(`exes ${path}`);
    // A 工作区可写 session's turn ends: the set-up folder is scanned again (here at once: no wait between scans).
    await until(folders, (f) => mine(f).state === "ready");
    await call(host, "POST", `/api/sessions/${session.id}/messages`, { text: "再来" });
    await idle(host, session.id);
    await until(() => fake.done.length, (n) => n === 5);
    expect(fake.done[4]).toBe(`exes ${path}`);

    // 恢复原来的权限 (2026-10-26): the full control Studio granted goes too (it has the backup); no longer set up.
    await until(folders, (f) => mine(f).state === "ready");
    await call(host, "POST", `/api/dsh/folders/${session.workspaceId}/revert`);
    const reverted = await until(folders, (f) => mine(f).state === "unprepared");
    expect(mine(reverted)).toEqual(expect.objectContaining({ fullControl: false }));
    expect(fake.done[5]).toBe(`revert ${path} granted`);
    await expect(call(host, "POST", `/api/dsh/folders/${session.workspaceId}/scan`)).rejects.toThrow(/先「设置权限」/);
  });

  it("session_start with write in a folder not set up says so to the agent; set up, it does not (2026-10-23)", async () => {
    const fake = fakeFolders({ ok: true, labelled: false });
    const host = await boot({ dshFolderAccess: fake.folderAccess });
    const session = await start(host, `[[mcp: session_start {"text":"你好","permission":"write"}]]`);
    await idle(host, session.id);
    expect(replies(await items(host, session.id)).join("\n")).toMatch(/"sandbox":\s*"这个项目还没为 DSH/);
    await call(host, "POST", `/api/dsh/folders/${session.workspaceId}/fix`);
    await until(() => call<{ state: string }>(host, "GET", `/api/dsh/folders/${session.workspaceId}`), (f) => f.state === "ready");
    // Full control was there already: only the label and the exes.
    expect(fake.done.map((d) => d.split(" ")[0])).toEqual(["label", "exes"]);
    await call(host, "POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: session_start {"text":"再开一个","permission":"write"}]]` });
    await idle(host, session.id);
    const last = replies(await items(host, session.id)).at(-1)!;
    expect(last).toMatch(/sessionId/);
    expect(last).not.toMatch(/"sandbox"/);
  });

  it("signs in with the DSH desktop app's DeepSeek account when no key is saved: no key, the app's credentials file, the account's models (2026-11-03)", async () => {
    const appHome = join(root, "desktop-home");
    mkdirSync(appHome);
    const file = join(appHome, ".credentials.yaml");
    writeFileSync(file, "version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n");
    process.env.DSH_HOME = appHome;
    const host = await boot({ credentials: new StaticCredentialReader({}) });
    expect(await call<DshStatus>(host, "GET", "/api/dsh")).toMatchObject({ auth: "account", keySaved: false, account: { file, signedIn: true } });
    const checked = await call<DshStatus>(host, "POST", "/api/dsh/check");
    expect(checked.check).toMatchObject({ ok: true, message: "可用 · ACP 1 · 2 个型号 · 用桌面版登录的 DeepSeek 账号" });
    // Only the account's models (DSH also lists the key's route when the app's file holds a key).
    const choices = await call<ProfileChoices>(host, "GET", "/api/profiles/dsh-deepseek/choices");
    expect(choices.models.map((m) => m.id)).toEqual(["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro"]);
    expect(choices.models[0]).toMatchObject({ isDefault: true });

    const s = await start(host, "[[auth]]");
    await until(() => items(host, s.id), (l) => replies(l).length === 1);
    expect(replies(await items(host, s.id))[0]).toBe(`AUTH key=no credentials=${file} model=["deepseek-account","deepseek-flash"]`);
    await idle(host, s.id);
    await call(host, "PATCH", `/api/sessions/${s.id}/options`, { model: "deepseek-account/deepseek-v4-pro" });
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[auth]]" });
    await until(() => items(host, s.id), (l) => replies(l).length === 2);
    expect(replies(await items(host, s.id))[1]).toBe(`AUTH key=no credentials=${file} model=["deepseek-account","deepseek-v4-pro"]`);
    await idle(host, s.id);

    // Signed out in the app: a new session says what to do.
    writeFileSync(file, "version: 1\nrecords: {}\n");
    expect((await call<DshStatus>(host, "GET", "/api/dsh")).account.signedIn).toBe(false);
    await expect(call(host, "POST", "/api/tasks", { title: "没登录", workspaceId: s.workspaceId, firstSession: { profileId: "dsh-deepseek", text: "hi" } })).rejects.toThrow(/桌面版还没有登录 DeepSeek 账号/);
  });

  it("an API key typed in 设置 is saved and given to DSH; 「API Key」 without one says so (2026-11-03)", async () => {
    process.env.DSH_HOME = join(root, "no-desktop-app");
    const host = await boot({ credentials: new StaticCredentialReader({}) });
    expect(await call<DshStatus>(host, "PUT", "/api/dsh", { auth: "key" })).toMatchObject({ auth: "key", keySaved: false });
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const task = (text: string) => call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { title: "DSH 任务", workspaceId: ws.id, firstSession: { profileId: "dsh-deepseek", text } });
    await expect(task("hi")).rejects.toThrow(/还没有 DeepSeek 的 API Key/);

    const saved = await call<CredentialStatus[]>(host, "PUT", "/api/credentials/deepseek-v4", { secret: "sk-typed" });
    expect(saved.find((c) => c.id === "deepseek-v4")).toMatchObject({ saved: true, writable: true, usedBy: ["DeepSeek"] });
    expect(await call<DshStatus>(host, "GET", "/api/dsh")).toMatchObject({ auth: "key", keySaved: true });
    const { session } = await task("[[endpoint]]");
    await until(() => items(host, session.id), (l) => replies(l).length === 1);
    expect(replies(await items(host, session.id))[0]).toMatch(/^ENDPOINT base= key=sk-typed model=\["deepseek-official","deepseek-v4-flash"\]$/);
  });

  it("立即发送 and Ctrl+Enter: the running turn gives way and the waiting message goes at once (2026-11-04)", async () => {
    const host = await boot();
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "先看这个" });
    const row = userRow(await items(host, s.id), "先看这个")!;
    expect(row.delivery).toBe("waiting");
    await call(host, "POST", `/api/sessions/${s.id}/items/${row.id}/send-now`);
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 先看这个"));
    await idle(host, s.id);
    expect((await items(host, s.id)).filter((i) => i.type === "turn").map((t) => (t.type === "turn" ? t.state : ""))).toEqual(["interrupted", "completed"]);

    // Ctrl+Enter (`now`) while a turn runs: the same, in one step.
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[slow]]" });
    await until(() => status(host, s.id), (v) => v === "running");
    await until(() => items(host, s.id), (l) => l.filter((i) => i.type === "tool").length === 2);
    expect((await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/messages`, { text: "马上读", now: true })).mode).toBe("queue");
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 马上读"));
    await idle(host, s.id);
  });

  it("a turn that fails, or a process closed after 停止 went unanswered, leaves the waiting messages 没送到; 重新发送 sends them (2026-11-04)", async () => {
    const host = await boot({ stopGraceMs: 500 });
    const s = await start(host, "[[fail-after: 800]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "第二件事" });
    await until(() => status(host, s.id), (v) => v === "error");
    const lost = userRow(await items(host, s.id), "第二件事")!;
    expect(lost.delivery).toBe("unsent");
    expect(await call<{ mode: string }>(host, "POST", `/api/sessions/${s.id}/items/${lost.id}/resend`)).toMatchObject({ mode: "start" });
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 第二件事"));
    await idle(host, s.id);
    // The same row went again: no second copy.
    expect((await items(host, s.id)).filter((i) => i.type === "user" && i.text === "第二件事")).toHaveLength(1);
    expect(userRow(await items(host, s.id), "第二件事")?.delivery).toBeUndefined();

    // 停止 on a DSH that does not stop: its process is closed, the turn reads as stopped, what waited is 没送到.
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[stuck]]" });
    await until(() => items(host, s.id), (l) => l.filter((i) => i.type === "tool").length === 2);
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "第三件事" });
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.filter((i) => i.type === "turn").at(-1)).toMatchObject({ state: "interrupted" });
    expect(list.some((i) => i.type === "notice" && i.message.includes("DSH 还没停下"))).toBe(true);
    expect(list.some((i) => i.type === "error" && list.indexOf(i) > list.indexOf(userRow(list, "[[stuck]]")!))).toBe(false);
    expect(userRow(list, "第三件事")).toMatchObject({ delivery: "unsent" });
  });

  it("停止's fallback is for the stopped prompt only: one sent right after a quick stop runs to its end (2026-11-09)", async () => {
    const host = await boot({ stopGraceMs: 500 });
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    await call(host, "POST", `/api/sessions/${s.id}/interrupt`);
    await idle(host, s.id);
    // Takes 1.5 s, three times the grace, in the same process.
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "[[subagent: 1500]]" });
    await until(() => items(host, s.id), (l) => replies(l).some((r) => r.startsWith("SUB DONE ")));
    await idle(host, s.id);
    const list = await items(host, s.id);
    expect(list.some((i) => i.type === "notice" && i.message.includes("DSH 还没停下"))).toBe(false);
    expect(list.filter((i) => i.type === "turn").at(-1)).toMatchObject({ state: "completed" });
  });

  it("a message waiting when the Host stops is 没送到 after the restart, and can be sent again (2026-11-04)", async () => {
    let host = await boot();
    const s = await start(host, "[[slow]]");
    await until(() => items(host, s.id), (l) => l.some((i) => i.type === "tool"));
    await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "还没读到" });
    await running.pop()!.shutdown();

    host = await boot();
    const list = await items(host, s.id);
    expect(await status(host, s.id)).toBe("interrupted");
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "interrupted" });
    const row = userRow(list, "还没读到")!;
    expect(row.delivery).toBe("unsent");
    await call(host, "POST", `/api/sessions/${s.id}/items/${row.id}/resend`);
    await until(() => items(host, s.id), (l) => replies(l).includes("MOCK-DSH: 还没读到"));
    await idle(host, s.id);
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
