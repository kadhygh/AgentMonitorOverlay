import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Protector } from "@amo-studio/account";
import { listenInStudioRange, removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { PlatformClient } from "./client.js";
import { planLaunch, type LaunchSpec } from "./launch.js";
import { trayMenu } from "./tray.js";
import { Platform, type PlatformOptions } from "./platform.js";
import { channelFromArgs } from "./settings.js";
import { sessionCount, stopStudio, studioHealth, studioRestart, waitForExit, type StudioStop } from "./system.js";

const fake: Protector = { protect: async (t) => Buffer.from(t).toString("base64"), unprotect: async (d) => Buffer.from(d, "base64").toString() };

let server: FakePlatformServer;
let root = "";
beforeAll(async () => {
  server = await startFakePlatformServer({ users: { 小王: "secret" } });
  server.publish("studio", "0.9.0", { "AMO Studio.exe": "studio 0.9.0", "resources/app.asar": "a" }, { name: "AMO Studio", exe: "AMO Studio.exe", notes: "- 第一版" });
  server.publish("reviewer", "0.9.0", { "AMO Reviewer.exe": "reviewer" }, { name: "AMO Reviewer", exe: "AMO Reviewer.exe" });
  server.publish("platform", "0.9.0", { "AMO Platform.exe": "p" }, { exe: "AMO Platform.exe" });
});
afterAll(() => server.close());
afterEach(() => root && removeTempDir(root));

function make(options: { argv?: string[]; running?: string[]; extra?: Partial<PlatformOptions> } = {}) {
  root = mkdtempSync(join(tmpdir(), "amo-platform-"));
  const env = { AMO_HOME: join(root, "roaming"), AMO_LOCAL_HOME: join(root, "local"), PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1", AMO_STUDIO_DATA_DIR: "X:\\inherited" };
  const launched: LaunchSpec[] = [];
  const picks: string[] = [];
  const running = options.running ?? [];
  const platform = new Platform({
    env,
    argv: options.argv ?? [],
    version: "0.9.0",
    testMode: true,
    protector: fake,
    shell: { pickFolder: async () => picks.shift() ?? null, openPath: async () => undefined, setOpenAtLogin: () => undefined },
    runningPaths: async () => running,
    launch: async (spec) => void launched.push(spec),
    rootDrive: async () => "local",
    ...options.extra,
  });
  return { platform, env, launched, picks, running };
}

describe("Platform", () => {
  it("logs in, lists the channel's tools (not the platform itself), installs and opens; Studio only with its data dir", async () => {
    const { platform, launched, picks, env } = make();
    await platform.init();
    expect(platform.view().account).toBeNull();
    await platform.login(server.url, "小王", "wrong");
    expect(platform.view().loginError).toBe("名字或密码不对");
    await platform.login(server.url, "小王", "secret");
    const v = platform.view();
    expect(v.account).toEqual({ server: server.url, name: "小王" });
    expect(v.connection.state).toBe("online");
    expect(v.tools.map((t) => [t.id, t.available, t.installed])).toEqual([
      ["studio", "0.9.0", null],
      ["reviewer", "0.9.0", null],
    ]);
    expect(v.tools[0]!.notes).toBe("- 第一版");

    await platform.install("studio");
    expect(platform.view().tools[0]).toMatchObject({ installed: "0.9.0", task: null, result: { tone: "ok", text: "已装好 0.9.0" } });
    expect(platform.view().tools[1]!.hint).toContain("Studio 里已经带了");
    expect(platform.installedTools()).toEqual([{ id: "studio", name: "AMO Studio" }]);

    // No data dir yet: not started, and the page is told to go to 目录.
    expect(await platform.open("studio")).toMatchObject({ ok: false, reason: "need-studio-dir" });
    expect(launched).toEqual([]);
    // A data dir inside the installed programs is refused.
    picks.push(join(root, "local", "apps", "studio", "data"));
    await platform.pickStudioDataDir();
    expect(platform.view().dirs.studioData).toBeNull();
    expect(platform.view().tools[0]!.result?.text).toContain("不能放在工具的安装文件夹里");
    const data = join(root, "studio-data");
    picks.push(data);
    await platform.pickStudioDataDir();
    expect(platform.view().dirs.studioData).toBe(data);
    expect(JSON.parse(readFileSync(join(env.AMO_HOME, "platform.json"), "utf8"))).toMatchObject({ studioDataDir: data, server: server.url, lastName: "小王" });

    expect(await platform.open("studio")).toEqual({ ok: true });
    expect(launched[0]!.file).toMatch(/\\0\.9\.0\\AMO Studio\.exe$/);
    expect(launched[0]!.env.AMO_STUDIO_DATA_DIR).toBe(data);
    expect(launched[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("an update while the tool runs is installed all the same and says it takes effect next time", async () => {
    const { platform, running } = make();
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    await platform.install("reviewer");
    running.push(join(root, "local", "apps", "reviewer", "0.9.0", "AMO Reviewer.exe"));
    server.publish("reviewer", "0.9.1", { "AMO Reviewer.exe": "reviewer 2" }, { name: "AMO Reviewer", exe: "AMO Reviewer.exe", notes: "改了一点" });
    await platform.refresh();
    const r = platform.view().tools.find((t) => t.id === "reviewer")!;
    expect(r).toMatchObject({ installed: "0.9.0", available: "0.9.1", notes: "改了一点", running: true });
    await platform.install("reviewer");
    expect(platform.view().tools.find((t) => t.id === "reviewer")!).toMatchObject({ installed: "0.9.1", rollbackTo: "0.9.0", result: { text: "已更新到 0.9.1，AMO Reviewer 正在运行，下次打开生效" } });
    await platform.uninstall("reviewer");
    expect(platform.view().tools.find((t) => t.id === "reviewer")!.result).toEqual({ tone: "error", text: "AMO Reviewer 正在运行，先关掉它再卸载。" });
    server.setChannel("stable", "reviewer", "0.9.0");
  });

  it("registers: the server check, errors back to the form (not loginError), then logged in with the tools listed", async () => {
    const { platform, env } = make();
    await platform.init();
    expect(await platform.serverInfo(server.url.replace("http://", ""))).toEqual({ ok: true, name: "AMO 中转", invite: false });
    expect(await platform.serverInfo("127.0.0.1:1")).toMatchObject({ ok: false, message: expect.stringContaining("连不上 127.0.0.1:1") });
    expect(await platform.register({ server: server.url, name: "小王", password: "abcd", role: "" })).toEqual({ ok: false, code: "conflict", message: "名字「小王」已经有人用了" });
    expect(platform.view()).toMatchObject({ account: null, loginError: null, loggingIn: false });
    expect(await platform.register({ server: server.url, name: "小周", password: "abcd", role: "策划" })).toEqual({ ok: true });
    const v = platform.view();
    expect(v).toMatchObject({ account: { server: server.url, name: "小周" }, loginError: null, loggingIn: false, connection: { state: "online" } });
    expect(v.tools.map((t) => t.id)).toEqual(["studio", "reviewer"]);
    expect(JSON.parse(readFileSync(join(env.AMO_HOME, "platform.json"), "utf8"))).toMatchObject({ server: server.url, recentServers: [server.url], lastName: "小周" });
    expect(server.members()["小周"]).toEqual({ password: "abcd", role: "策划" });
  });

  it("账号: the profile comes with the login, 保存 changes it on the server, a refused change comes back to the page; logged out, it is gone", async () => {
    const { platform } = make();
    await platform.init();
    expect(platform.view().profile).toEqual({ state: "idle", data: null, message: null });
    expect(await platform.register({ server: server.url, name: "小吴", password: "abcd", role: "策划" })).toEqual({ ok: true });
    expect(platform.view().profile).toEqual({ state: "ready", data: { service: "AMO 中转", role: "策划", nick: "", avatar: null }, message: null });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(await platform.saveProfile({ nick: " 吴吴 ", avatar: png, role: "策划 · 数值" })).toEqual({ ok: true });
    expect(server.profile("小吴")).toEqual({ role: "策划 · 数值", nick: "吴吴", avatar: png });
    expect(platform.view().profile.data).toEqual({ service: "AMO 中转", role: "策划 · 数值", nick: "吴吴", avatar: png });
    expect(await platform.saveProfile({ nick: "x".repeat(40) })).toEqual({ ok: false, message: "昵称 太长（最多 32 字）" });
    expect(platform.view().account).not.toBeNull();
    // Someone changed it elsewhere: 账号 reads it again.
    await fetch(`${server.url}/api/login`, { method: "POST", body: JSON.stringify({ name: "小吴", password: "abcd" }) })
      .then((r) => r.json() as Promise<{ key: string }>)
      .then(({ key }) => fetch(`${server.url}/api/me`, { method: "PATCH", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ avatar: null }) }));
    await platform.loadProfile();
    expect(platform.view().profile.data?.avatar).toBeNull();
    await platform.logout();
    expect(platform.view().profile).toEqual({ state: "idle", data: null, message: null });
    expect(await platform.saveProfile({ nick: "a" })).toEqual({ ok: false, message: "还没登录" });
  });

  it("--channel test wins over the setting; a key the server no longer takes goes back to the login page", async () => {
    server.publish("studio", "0.9.5", { "AMO Studio.exe": "studio 0.9.5" }, { exe: "AMO Studio.exe", channel: "test" });
    const { platform } = make({ argv: ["electron", ".", "--channel", "test"] });
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    expect(platform.view()).toMatchObject({ channel: "test", channelFromArgs: true });
    expect(platform.view().tools[0]!.available).toBe("0.9.5");
    await platform.setChannel("stable");
    expect(platform.view().channel).toBe("test");
    server.revokeKeys();
    await platform.refresh();
    expect(platform.view()).toMatchObject({ account: null, loginError: "登录已失效，请重新登录。" });
    server.setChannel("test", "studio", "0.9.0");
  });

  // Last in this group: the published relay stays on the fake server.
  it("AMO 中转 is a tool like the others (2026-10-28): listed after Studio, installed, opened with the team server's address", async () => {
    server.publish("relay", "0.9.0", { "AMO Relay.exe": "relay 0.9.0", "resources/app/package.json": "{}" }, { name: "AMO Relay", exe: "AMO Relay.exe", notes: "- 从平台发布" });
    const { platform, launched } = make();
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    expect(platform.view().tools.map((t) => [t.id, t.name])).toEqual([
      ["studio", "AMO Studio"],
      ["relay", "AMO 中转"],
      ["reviewer", "AMO Reviewer（独立版）"],
    ]);
    const relay = () => platform.view().tools.find((t) => t.id === "relay")!;
    expect(relay()).toMatchObject({ available: "0.9.0", installed: null, notes: "- 从平台发布", hint: null });
    expect(relay().desc).toContain("桌面程序在这里更新");
    await platform.install("relay");
    expect(relay()).toMatchObject({ installed: "0.9.0", result: { tone: "ok", text: "已装好 0.9.0" } });
    expect(platform.installedTools()).toEqual([{ id: "relay", name: "AMO 中转" }]);
    expect(await platform.open("relay")).toEqual({ ok: true });
    expect(launched[0]!.file).toMatch(/\\relay\\0\.9\.0\\AMO Relay\.exe$/);
    expect(launched[0]!.args).toEqual(["--server", server.url, "--amo-tray=platform"]);
    expect(launched[0]!.env.AMO_STUDIO_DATA_DIR).toBeUndefined();
    // 关闭 (2026-10-29): the same exe, asked to quit; the tray has its part.
    expect(await platform.close("relay")).toEqual({ ok: true });
    expect(launched[1]!.args).toEqual(["--server", server.url, "--amo-tray=platform", "--amo-quit"]);
    expect(trayMenu(platform.trayState()).map((i) => (i.kind === "separator" ? "—" : i.label))).toEqual(["AMO 中转", "打开中转", "退出中转", "—", "AMO 平台", "打开 AMO 平台", "退出平台"]);
    // 便签 with neither its own install nor Studio: nothing to start it with.
    expect(platform.notesAvailable()).toBe(false);
    expect(await platform.toggleNotes()).toMatchObject({ ok: false, reason: "not-installed" });
  });
});

describe("launch and the machine", () => {
  it("plans a start: the real version folder, Studio's data dir, the platform's own variables dropped", () => {
    root = mkdtempSync(join(tmpdir(), "amo-platform-launch-"));
    mkdirSync(join(root, "1.0.0"));
    writeFileSync(join(root, "1.0.0", "Tool.exe"), "");
    const entry = { dir: join(root, "1.0.0"), exe: "Tool.exe" };
    expect(planLaunch("studio", entry, { studioDataDir: null, env: {} })).toMatchObject({ ok: false, reason: "need-studio-dir" });
    expect(planLaunch("notes", undefined, { studioDataDir: null, env: {}, name: "AMO 便签" })).toMatchObject({ ok: false, message: "AMO 便签 还没装。" });
    expect(planLaunch("notes", { ...entry, exe: "Gone.exe" }, { studioDataDir: null, env: {} })).toMatchObject({ ok: false, reason: "not-installed" });
    const p = planLaunch("notes", entry, { studioDataDir: "D:\\d", env: { PATH: "x", AMO_PLATFORM_TEST: "1", CLAUDECODE: "1" } });
    // Every tool leaves the tray to the platform (2026-10-29); what the tray or a card asks comes after.
    expect(p).toMatchObject({ ok: true, spec: { file: join(root, "1.0.0", "Tool.exe"), cwd: join(root, "1.0.0"), args: ["--amo-tray=platform"], env: { PATH: "x" } } });
    expect(planLaunch("notes", entry, { studioDataDir: null, env: {}, args: ["--amo-quit"] })).toMatchObject({ ok: true, spec: { args: ["--amo-tray=platform", "--amo-quit"] } });
    // Only AMO 中转 is handed the server (it fills in its address the first time); without a login, nothing.
    expect(planLaunch("notes", entry, { studioDataDir: null, env: {}, server: "http://s:1" })).toMatchObject({ ok: true, spec: { args: ["--amo-tray=platform"] } });
    expect(planLaunch("relay", entry, { studioDataDir: null, env: {}, server: "http://s:1" })).toMatchObject({ ok: true, spec: { args: ["--server", "http://s:1", "--amo-tray=platform"] } });
    expect(planLaunch("relay", entry, { studioDataDir: null, env: {}, server: null })).toMatchObject({ ok: true, spec: { args: ["--amo-tray=platform"] } });
    expect(channelFromArgs(["--channel=test"])).toBe("test");
    expect(channelFromArgs(["--channel", "beta"])).toBeNull();
  });

  it("a service with no platform folder or nothing published (404) has no tools, not an error", async () => {
    const notFound = (async () => new Response(JSON.stringify({ error: "not_found", message: "还没有发布过" }), { status: 404 })) as unknown as typeof fetch;
    expect(await new PlatformClient("http://127.0.0.1:1", "k", notFound).channels()).toEqual({ stable: {}, test: {} });
  });

  it("reads Studio's sessions from its Host, read only; no `running` field is unknown", async () => {
    let body: unknown = { ok: true, pid: 1 };
    let auth = "";
    const host = createServer((req, res) => {
      auth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const port = await listenInStudioRange(host);
    root = mkdtempSync(join(tmpdir(), "amo-platform-health-"));
    try {
      expect(await studioHealth(root)).toEqual({ hostUp: false, sessions: null, version: null });
      writeFileSync(join(root, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: 1 }));
      writeFileSync(join(root, "host-token"), "tok\n");
      expect(await studioHealth(root)).toEqual({ hostUp: true, sessions: null, version: null });
      expect(auth).toBe("Bearer tok");
      body = { ok: true, running: 2 };
      expect(await studioHealth(root)).toEqual({ hostUp: true, sessions: 2, version: null });
      // 2026-10-29: the version of the Studio that started the Host.
      body = { ok: true, running: 0, version: "0.9.4" };
      expect(await studioHealth(root)).toEqual({ hostUp: true, sessions: 0, version: "0.9.4" });
      expect(sessionCount([{}, {}, {}])).toBe(3);
      expect(sessionCount(true)).toBeNull();
    } finally {
      await new Promise<void>((r) => host.close(() => r()));
    }
  });

  it("重启 Studio is offered only when the running Host is older than the installed Studio, and not while sessions are at work (2026-10-29)", () => {
    const up = (version: string | null, sessions: number | null = 0) => ({ hostUp: true, sessions, version });
    expect(studioRestart(up("0.9.3"), "0.9.4")).toBe("ready");
    expect(studioRestart(up("0.9.3", 2), "0.9.4")).toBe("busy");
    // Sessions unknown (not expected with a version, both came 10-28/29) is not taken for busy; the Host refuses anyway.
    expect(studioRestart(up("0.9.3", null), "0.9.4")).toBe("ready");
    expect(studioRestart(up("0.9.4"), "0.9.4")).toBe("none");
    // Newer than installed (went back a version): not offered (the user's rule is "older").
    expect(studioRestart(up("0.9.5"), "0.9.4")).toBe("none");
    expect(studioRestart(up("dev"), "0.9.4")).toBe("none");
    expect(studioRestart(up(null), "0.9.4")).toBe("unsupported");
    expect(studioRestart({ hostUp: false, sessions: null, version: null }, "0.9.4")).toBe("none");
    expect(studioRestart(up("0.9.3"), null)).toBe("none");
  });

  it("stopStudio: POST /api/shutdown with the data dir's token and never `interrupt`; 409 says how many, 404 is an older Studio; the Host and shell pids to wait for (2026-10-29)", async () => {
    let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, running: 0 } };
    const seen: Array<{ method: string; path: string; auth: string; body: string }> = [];
    const host = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    const port = await listenInStudioRange(host);
    root = mkdtempSync(join(tmpdir(), "amo-platform-stop-"));
    try {
      expect(await stopStudio(root)).toMatchObject({ ok: false, reason: "not-running" });
      writeFileSync(join(root, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: 4242 }));
      expect(await stopStudio(root)).toMatchObject({ ok: false, reason: "failed", message: expect.stringContaining("host-token") });
      writeFileSync(join(root, "host-token"), "tok\n");
      writeFileSync(join(root, "shell.json"), JSON.stringify({ pid: 4343, version: "0.9.3" }));
      reply = { status: 409, body: { ok: false, running: 2, error: { code: "conflict", message: "2 个会话正在进行" } } };
      expect(await stopStudio(root)).toEqual({ ok: false, reason: "running", running: 2 });
      expect(seen.at(-1)).toEqual({ method: "POST", path: "/api/shutdown", auth: "Bearer tok", body: "{}" });
      reply = { status: 404, body: { error: { code: "not_found", message: "no route" } } };
      expect(await stopStudio(root)).toMatchObject({ ok: false, reason: "unsupported" });
      reply = { status: 200, body: { ok: true, running: 0 } };
      expect(await stopStudio(root)).toEqual({ ok: true, pids: [4242, 4343] });
      expect(seen.every((r) => !r.body.includes("interrupt"))).toBe(true);
    } finally {
      await new Promise<void>((r) => host.close(() => r()));
    }
    let oneGone = false;
    setTimeout(() => (oneGone = true), 100);
    expect(await waitForExit([1, 2], 2000, (pid) => pid === 1 && !oneGone)).toEqual([]);
    expect(await waitForExit([3], 300, () => true)).toEqual([3]);
  });

  it("the Studio card: the Host's state and version; 重启 Studio — refused while sessions are at work, else the old one stops and the installed one opens (2026-10-29)", async () => {
    let health: Record<string, unknown> = { ok: true, pid: 4242, running: 0, version: "0.8.0" };
    // The Host is a stand-in at 127.0.0.1:47999; the team server's requests go out for real.
    const routed = ((url: string | URL, init?: RequestInit) =>
      String(url).startsWith("http://127.0.0.1:47999/") ? Promise.resolve(new Response(JSON.stringify(health), { status: 200, headers: { "content-type": "application/json" } })) : fetch(url, init)) as typeof fetch;
    let stop: StudioStop = { ok: false, reason: "running", running: 1 };
    let left: number[] = [];
    const waited: Array<readonly number[]> = [];
    const { platform, launched, picks } = make({
      extra: {
        fetch: routed,
        stopStudio: async () => stop,
        waitForExit: async (pids) => (waited.push(pids), left),
      },
    });
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    await platform.install("studio");
    const card = () => platform.view().tools.find((t) => t.id === "studio")!;
    // No data dir: nothing to ask.
    expect(card().studio).toEqual({ hostUp: false, sessions: null, version: null, restart: "none", restarting: false });
    const data = join(root, "studio-data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "host.json"), JSON.stringify({ url: "http://127.0.0.1:47999", port: 47999, pid: 4242 }));
    picks.push(data);
    await platform.pickStudioDataDir();
    expect(card().studio).toEqual({ hostUp: true, sessions: 0, version: "0.8.0", restart: "ready", restarting: false });
    health = { ...health, running: 2 };
    await platform.refreshStudio();
    expect(card().studio).toMatchObject({ sessions: 2, restart: "busy" });

    // The Host refuses (a session started meanwhile): said, nothing opened.
    await platform.restartStudio();
    expect(card().result).toEqual({ tone: "warn", text: "1 个会话进行中，没有重启。等它们停下后再重启 Studio。" });
    expect(launched).toEqual([]);
    // An older Host without the route.
    stop = { ok: false, reason: "unsupported", message: "这个后台是更早的 Studio 启动的，不能从这里关掉。" };
    await platform.restartStudio();
    expect(card().result).toMatchObject({ tone: "error", text: expect.stringContaining("任务管理器") });
    // Accepted, but the old shell does not end in time: the new one is not opened.
    stop = { ok: true, pids: [4242, 4343] };
    left = [4343];
    await platform.restartStudio();
    expect(waited.at(-1)).toEqual([4242, 4343]);
    expect(card().result).toMatchObject({ tone: "error", text: expect.stringContaining("旧的 Studio 还没退出（进程 4343") });
    expect(launched).toEqual([]);
    // Both ended: the installed Studio opens with its data dir.
    left = [];
    health = { ok: true, pid: 5000, running: 0, version: "0.9.0" };
    await platform.restartStudio();
    expect(card().result).toEqual({ tone: "ok", text: "已重启 Studio，现在是 0.9.0" });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.file).toMatch(/\\0\.9\.0\\AMO Studio\.exe$/);
    expect(launched[0]!.env.AMO_STUDIO_DATA_DIR).toBe(data);
    expect(card().studio).toEqual({ hostUp: true, sessions: 0, version: "0.9.0", restart: "none", restarting: false });
    // A Host too old to say its version.
    health = { ok: true, pid: 5000, running: 0 };
    await platform.refreshStudio();
    expect(card().studio).toMatchObject({ version: null, restart: "unsupported" });
  });
});
