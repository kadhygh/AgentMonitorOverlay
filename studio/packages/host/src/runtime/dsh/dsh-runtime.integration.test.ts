import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DshStatus, ModelProfile, ProfileChoices, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { fakeAcpAgent, removeTempDir, TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../credentials.js";
import type { FolderAccess } from "./folder-access.js";

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
    await expect(call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "看图", attachments: [await upload()] })).rejects.toThrow(/deepseek-v4-flash 不收图片.*DeepSeek-V4.1-Flash/);
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

  it("fails a turn when DSH fails it", async () => {
    const host = await boot();
    const s = await start(host, "[[fail]]");
    await until(() => status(host, s.id), (v) => v === "error");
    const list = await items(host, s.id);
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "failed" });
    expect(list.find((i) => i.type === "error")).toMatchObject({ message: expect.stringContaining("fake failure") });
  });
});
