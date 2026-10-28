import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Protector } from "@amo-studio/account";
import { listenInStudioRange, removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { PlatformClient } from "./client.js";
import { planLaunch, type LaunchSpec } from "./launch.js";
import { Platform } from "./platform.js";
import { channelFromArgs } from "./settings.js";
import { sessionCount, studioHealth } from "./system.js";

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

function make(options: { argv?: string[]; running?: string[] } = {}) {
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
    expect(p).toMatchObject({ ok: true, spec: { file: join(root, "1.0.0", "Tool.exe"), cwd: join(root, "1.0.0"), env: { PATH: "x" } } });
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
      expect(await studioHealth(root)).toEqual({ hostUp: false, sessions: null });
      writeFileSync(join(root, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: 1 }));
      writeFileSync(join(root, "host-token"), "tok\n");
      expect(await studioHealth(root)).toEqual({ hostUp: true, sessions: null });
      expect(auth).toBe("Bearer tok");
      body = { ok: true, running: 2 };
      expect(await studioHealth(root)).toEqual({ hostUp: true, sessions: 2 });
      expect(sessionCount([{}, {}, {}])).toBe(3);
      expect(sessionCount(true)).toBeNull();
    } finally {
      await new Promise<void>((r) => host.close(() => r()));
    }
  });
});
