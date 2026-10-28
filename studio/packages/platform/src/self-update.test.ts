import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Protector } from "@amo-studio/account";
import { removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import type { LaunchSpec } from "./launch.js";
import { Platform } from "./platform.js";
import { afterPid, currentExe, loginItemExe, oldFolder, restartArgs, selfPlace, selfStanding } from "./self-update.js";

// The platform updating itself (self-update.ts): where it runs from, how it stands, what starts with Windows, and the
// whole round against the fake server — from an unpacked zip into <apps>\platform, 重启平台 recorded, never done.

let root = "";
afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});
const temp = () => (root = mkdtempSync(join(tmpdir(), "amo-self-")));

describe("where the platform runs from", () => {
  it("dev without a program; installed under <apps>\\platform (through current or a version folder); loose anywhere else", () => {
    const r = temp();
    const apps = join(r, "local", "apps");
    mkdirSync(join(apps, "platform", "0.9.2"), { recursive: true });
    symlinkSync(join(apps, "platform", "0.9.2"), join(apps, "platform", "current"), "junction");
    expect(selfPlace(null, apps)).toEqual({ kind: "dev" });
    expect(selfPlace(join(apps, "platform", "0.9.2", "AMO Platform.exe"), apps)).toMatchObject({ kind: "installed", dir: join(apps, "platform", "0.9.2") });
    expect(selfPlace(join(apps, "platform", "current", "AMO Platform.exe"), apps)).toMatchObject({ kind: "installed", dir: join(apps, "platform", "current") });
    // Windows paths are not case sensitive.
    expect(selfPlace(join(apps, "PLATFORM", "0.9.2", "AMO Platform.exe"), apps).kind).toBe("installed");
    expect(selfPlace(join(r, "Downloads", "AMO Platform", "AMO Platform.exe"), apps)).toEqual({ kind: "loose", exe: join(r, "Downloads", "AMO Platform", "AMO Platform.exe"), dir: join(r, "Downloads", "AMO Platform") });
    // Another tool's folder, or one beside the platform's, is not the platform's.
    expect(selfPlace(join(apps, "studio", "0.9.0", "AMO Platform.exe"), apps).kind).toBe("loose");
    expect(selfPlace(join(apps, "platform-old", "AMO Platform.exe"), apps).kind).toBe("loose");
  });

  it("the target is <apps>\\platform\\current\\<exe> from either place; starting with Windows follows it once installed", () => {
    const apps = "C:\\Users\\x\\AppData\\Local\\AMO\\apps";
    const target = currentExe(apps, "AMO Platform.exe");
    expect(target).toBe("C:\\Users\\x\\AppData\\Local\\AMO\\apps\\platform\\current\\AMO Platform.exe");
    expect(currentExe(apps, "bin/AMO Platform.exe")).toBe(join(apps, "platform", "current", "bin", "AMO Platform.exe"));
    const loose = { kind: "loose" as const, exe: "D:\\Downloads\\AMO Platform\\AMO Platform.exe", dir: "D:\\Downloads\\AMO Platform" };
    const installed = { kind: "installed" as const, exe: join(apps, "platform", "0.9.2", "AMO Platform.exe"), dir: join(apps, "platform", "0.9.2") };
    // From the zip, before anything is installed: the zip's program; after the first update: current.
    expect(loginItemExe(loose, null)).toBe(loose.exe);
    expect(loginItemExe(loose, target)).toBe(target);
    // Started from a version folder: still current, not that folder (it goes two updates later).
    expect(loginItemExe(installed, target)).toBe(target);
    // Development: main.ts registers electron with this package.
    expect(loginItemExe({ kind: "dev" }, target)).toBeNull();
  });
});

describe("how it stands", () => {
  const stand = (o: Partial<Parameters<typeof selfStanding>[0]>) => selfStanding({ place: "installed", running: "0.9.1", installed: "0.9.1", available: "0.9.1", installedThisRun: false, ...o });
  it("dev never updates; a newer channel version is an update; installed newer than running is a restart (or, found at start, 打开那个)", () => {
    expect(stand({ place: "dev", available: "9.9.9" })).toBe("dev");
    expect(stand({})).toBe("latest");
    expect(stand({ available: "0.9.2" })).toBe("update");
    expect(stand({ available: "0.9.10" })).toBe("update");
    expect(stand({ available: "0.9.1-beta" })).toBe("latest");
    expect(stand({ available: "0.9.0" })).toBe("latest");
    expect(stand({ available: null })).toBe("latest");
    expect(stand({ place: "loose", installed: null, available: "0.9.2" })).toBe("update");
    expect(stand({ installed: "0.9.2", available: "0.9.2", installedThisRun: true })).toBe("restart");
    expect(stand({ place: "loose", installed: "0.9.2", available: "0.9.2", installedThisRun: true })).toBe("restart");
    // An old zip opened again while <apps>\platform has a newer one: that one first, even when the channel is newer still.
    expect(stand({ place: "loose", installed: "0.9.2", available: "0.9.3" })).toBe("newer-here");
    expect(stand({ place: "loose", installed: "0.9.0", available: "0.9.1" })).toBe("latest");
  });

  it("restart arguments keep --channel and add --after; the old zip folder is named while it is there", () => {
    expect(restartArgs(["C:\\x\\AMO Platform.exe", "--channel", "test", "--hidden", "--after=12"], 40)).toEqual(["--channel", "test", "--after=40"]);
    expect(restartArgs(["electron", "main.js", "--channel=stable"], 7)).toEqual(["--channel=stable", "--after=7"]);
    expect(afterPid(["x", "--after=1234"])).toBe(1234);
    expect(afterPid(["x", "--after=nope"])).toBeNull();
    expect(afterPid(["x"])).toBeNull();
    const r = temp();
    const zip = join(r, "zip");
    mkdirSync(zip);
    const installed = { kind: "installed" as const, exe: join(r, "apps", "platform", "0.9.2", "AMO Platform.exe"), dir: join(r, "apps", "platform", "0.9.2") };
    expect(oldFolder(zip, installed)).toBe(zip);
    expect(oldFolder(join(r, "gone"), installed)).toBeNull();
    expect(oldFolder(zip, { kind: "loose", exe: join(zip, "AMO Platform.exe"), dir: zip })).toBeNull();
    expect(oldFolder(null, installed)).toBeNull();
  });
});

describe("Platform's own update against the server", () => {
  const fake: Protector = { protect: async (t) => Buffer.from(t).toString("base64"), unprotect: async (d) => Buffer.from(d, "base64").toString() };
  let server: FakePlatformServer;
  beforeAll(async () => {
    server = await startFakePlatformServer({ users: { 小王: "secret" } });
    // A runtime shared with a tool (共用 Electron): the platform's update links it instead of downloading it.
    server.publish("notes", "1.0.0", { "AMO Notes.exe": "electron", "resources/app.txt": "notes" }, { exe: "AMO Notes.exe" });
    server.publish("platform", "0.9.2", { "AMO Platform.exe": "electron", "resources/app.txt": "platform 0.9.2" }, { exe: "AMO Platform.exe", notes: "- 平台能自己更新了" });
  });
  afterAll(() => server.close());

  function make(selfExe: string | null, version = "0.9.1") {
    const r = root || temp();
    const env = { AMO_HOME: join(r, "roaming"), AMO_LOCAL_HOME: join(r, "local"), PATH: process.env.PATH, AMO_PLATFORM_UI_DIR: "X:\\ui", ELECTRON_RUN_AS_NODE: "1" };
    const restarts: LaunchSpec[] = [];
    const loginItems: Array<[boolean, string | null]> = [];
    const platform = new Platform({
      env,
      argv: ["C:\\zip\\AMO Platform.exe", "--channel", "stable"],
      version,
      testMode: true,
      protector: fake,
      shell: { pickFolder: async () => null, openPath: async () => undefined, setOpenAtLogin: (on, exe) => void loginItems.push([on, exe]) },
      runningPaths: async () => [],
      selfExe,
      restart: async (spec) => void restarts.push(spec),
      pid: 4321,
    });
    return { platform, env, restarts, loginItems, apps: join(r, "local", "apps") };
  }

  it("from an unpacked zip: 更新平台 installs into <apps>\\platform\\<version>, starting with Windows moves there, 重启平台 starts current's real folder", async () => {
    const r = temp();
    const zip = join(r, "Downloads", "AMO Platform");
    mkdirSync(zip, { recursive: true });
    writeFileSync(join(zip, "AMO Platform.exe"), "electron");
    const { platform, restarts, loginItems, apps, env } = make(join(zip, "AMO Platform.exe"));
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    await platform.setOpenAtLogin(true);
    expect(loginItems.at(-1)).toEqual([true, join(zip, "AMO Platform.exe")]);
    await platform.install("notes");

    let s = platform.view().self;
    expect(s).toMatchObject({ place: "loose", dir: zip, standing: "update", available: "0.9.2", installed: null, notes: "- 平台能自己更新了", home: join(apps, "platform") });
    // Not a tool on 工具.
    expect(platform.view().tools.map((t) => t.id)).toEqual(["notes"]);

    await platform.updateSelf();
    s = platform.view().self;
    expect(s).toMatchObject({ standing: "restart", installed: "0.9.2", task: null, oldFolder: null });
    // The shared runtime file came from the 便签's folder.
    expect(s.result).toEqual({ tone: "ok", text: "已装好 0.9.2（1 个文件本机已经有了，没有重新下载）" });
    expect(readFileSync(join(apps, "platform", "0.9.2", "resources", "app.txt"), "utf8")).toBe("platform 0.9.2");
    expect(readFileSync(join(apps, "platform", "current", "AMO Platform.exe"), "utf8")).toBe("electron");
    expect(loginItems.at(-1)).toEqual([true, join(apps, "platform", "current", "AMO Platform.exe")]);
    expect(JSON.parse(readFileSync(join(env.AMO_HOME, "platform.json"), "utf8"))).toMatchObject({ zipFolder: zip, openAtLogin: true });

    await platform.restartSelf();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({ file: join(apps, "platform", "0.9.2", "AMO Platform.exe"), cwd: join(apps, "platform", "0.9.2"), args: ["--channel", "stable", "--after=4321"] });
    // Its own settings and login come from AMO_HOME as before; the variables only this run had are not passed on.
    expect(restarts[0]!.env).toMatchObject({ AMO_HOME: env.AMO_HOME, AMO_LOCAL_HOME: env.AMO_LOCAL_HOME });
    expect(restarts[0]!.env.AMO_PLATFORM_UI_DIR).toBeUndefined();
    expect(restarts[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("restarted from <apps>\\platform: logged in, up to date, the zip folder named until 知道了; an old zip opened again offers 打开那个", async () => {
    const r = temp();
    const zip = join(r, "Downloads", "AMO Platform");
    mkdirSync(zip, { recursive: true });
    const first = make(join(zip, "AMO Platform.exe"));
    await first.platform.init();
    await first.platform.login(server.url, "小王", "secret");
    await first.platform.updateSelf();

    const after = make(join(first.apps, "platform", "current", "AMO Platform.exe"), "0.9.2");
    await after.platform.init();
    let v = after.platform.view();
    expect(v.account).toMatchObject({ name: "小王" });
    expect(v.self).toMatchObject({ place: "installed", standing: "latest", installed: "0.9.2", oldFolder: zip });
    await after.platform.dismissSelf("old-folder");
    expect(after.platform.view().self.oldFolder).toBeNull();

    const old = make(join(zip, "AMO Platform.exe"));
    await old.platform.init();
    v = old.platform.view();
    expect(v.self).toMatchObject({ place: "loose", standing: "newer-here", installed: "0.9.2" });
    await old.platform.restartSelf();
    expect(old.restarts[0]!.file).toBe(join(first.apps, "platform", "0.9.2", "AMO Platform.exe"));
  });

  it("development: no update, no restart, and nothing installed", async () => {
    const { platform, restarts, apps } = make(null);
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    expect(platform.view().self).toMatchObject({ place: "dev", dir: null, standing: "dev", available: "0.9.2" });
    await platform.updateSelf();
    expect(platform.view().self.result).toEqual({ tone: "warn", text: "这是从源码启动的开发版，不自己更新。" });
    await platform.restartSelf();
    expect(restarts).toEqual([]);
    expect(existsSync(join(apps, "platform"))).toBe(false);
  });
});
