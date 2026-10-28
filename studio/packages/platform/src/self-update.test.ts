import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Protector } from "@amo-studio/account";
import { removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import type { LaunchSpec } from "./launch.js";
import { Platform, type PlatformOptions } from "./platform.js";
import { afterPid, currentExe, entryExe, forwardArgs, forwardTarget, loginItemExe, platformRoot, restartArgs, selfPlace, selfStanding } from "./self-update.js";

// The platform updating itself (self-update.ts): its folder (the root: where it was unpacked, 2026-10-28), where it runs
// from, the entry's forwarding, how it stands, what starts with Windows, and the whole round against the fake server —
// from the unpacked folder into <root>\apps\platform, 重启平台 recorded, never done; started from there, the entry
// brought to the new version.

let root = "";
afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});
const temp = () => (root = mkdtempSync(join(tmpdir(), "amo-self-")));
const ino = (p: string) => statSync(p, { bigint: true }).ino;

describe("the platform's folder and where it runs from", () => {
  it("the root: AMO_LOCAL_HOME always; from the sources %LOCALAPPDATA%\\AMO; from <x>\\apps\\platform\\<version> it is <x>; else the exe's folder", () => {
    const local = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
    expect(platformRoot(null, local)).toBe("C:\\Users\\x\\AppData\\Local\\AMO");
    expect(platformRoot("D:\\TOOLS\\AMO Platform\\AMO Platform.exe", local)).toBe("D:\\TOOLS\\AMO Platform");
    expect(platformRoot("D:\\TOOLS\\AMO Platform\\apps\\platform\\0.9.5\\AMO Platform.exe", local)).toBe("D:\\TOOLS\\AMO Platform");
    expect(platformRoot("D:\\TOOLS\\AMO Platform\\apps\\platform\\current\\AMO Platform.exe", local)).toBe("D:\\TOOLS\\AMO Platform");
    // Windows paths are not case sensitive.
    expect(platformRoot("D:\\TOOLS\\AMO Platform\\Apps\\PLATFORM\\0.9.5\\AMO Platform.exe", local)).toBe("D:\\TOOLS\\AMO Platform");
    // Another tool's folder, or one only named alike, is not the platform's.
    expect(platformRoot("D:\\TOOLS\\AMO Platform\\apps\\studio\\0.9.0\\AMO Platform.exe", local)).toBe("D:\\TOOLS\\AMO Platform\\apps\\studio\\0.9.0");
    expect(platformRoot("D:\\x\\platform\\0.9.5\\AMO Platform.exe", local)).toBe("D:\\x\\platform\\0.9.5");
    // AMO_LOCAL_HOME (tests, development) wins over all of them.
    for (const exe of [null, "D:\\TOOLS\\AMO Platform\\AMO Platform.exe", "D:\\TOOLS\\AMO Platform\\apps\\platform\\0.9.5\\AMO Platform.exe"]) expect(platformRoot(exe, { ...local, AMO_LOCAL_HOME: "E:\\amo-test" })).toBe("E:\\amo-test");
  });

  it("dev without a program; installed under <root>\\apps\\platform (through current or a version folder); the entry anywhere else", () => {
    const r = temp();
    const unpacked = join(r, "TOOLS", "AMO Platform");
    const home = join(unpacked, "apps", "platform");
    mkdirSync(join(home, "0.9.2"), { recursive: true });
    symlinkSync(join(home, "0.9.2"), join(home, "current"), "junction");
    const env = { LOCALAPPDATA: join(r, "local") };
    expect(selfPlace(null, env)).toEqual({ kind: "dev", root: join(r, "local", "AMO") });
    expect(selfPlace(join(unpacked, "AMO Platform.exe"), env)).toEqual({ kind: "outer", exe: join(unpacked, "AMO Platform.exe"), dir: unpacked, root: unpacked });
    expect(selfPlace(join(home, "0.9.2", "AMO Platform.exe"), env)).toEqual({ kind: "installed", exe: join(home, "0.9.2", "AMO Platform.exe"), dir: join(home, "0.9.2"), root: unpacked });
    expect(selfPlace(join(home, "current", "AMO Platform.exe"), env)).toMatchObject({ kind: "installed", dir: join(home, "current"), root: unpacked });
    // With AMO_LOCAL_HOME the root is there, and only its apps\platform counts as installed.
    const moved = { ...env, AMO_LOCAL_HOME: join(r, "elsewhere") };
    expect(selfPlace(join(home, "0.9.2", "AMO Platform.exe"), moved)).toMatchObject({ kind: "outer", root: join(r, "elsewhere") });
  });

  it("the entry is <root>\\AMO Platform.exe; starting with Windows registers it (falling back to current when there is none)", () => {
    const r = temp();
    const unpacked = join(r, "AMO Platform");
    const apps = join(unpacked, "apps");
    const outer = selfPlace(join(unpacked, "AMO Platform.exe"), {});
    const installed = selfPlace(join(apps, "platform", "0.9.2", "AMO Platform.exe"), {});
    const current = currentExe(apps, "AMO Platform.exe");
    expect(current).toBe(join(apps, "platform", "current", "AMO Platform.exe"));
    expect(currentExe(apps, "bin/AMO Platform.exe")).toBe(join(apps, "platform", "current", "bin", "AMO Platform.exe"));
    expect(entryExe(outer)).toBe(join(unpacked, "AMO Platform.exe"));
    expect(entryExe(installed)).toBe(join(unpacked, "AMO Platform.exe"));
    expect(entryExe({ kind: "dev", root: r })).toBeNull();
    // The entry, from either place (it forwards to a newer version by itself).
    expect(loginItemExe(outer, current)).toBe(join(unpacked, "AMO Platform.exe"));
    mkdirSync(unpacked, { recursive: true });
    expect(loginItemExe(installed, current)).toBe(current);
    writeFileSync(join(unpacked, "AMO Platform.exe"), "entry");
    expect(loginItemExe(installed, current)).toBe(join(unpacked, "AMO Platform.exe"));
    expect(loginItemExe({ kind: "dev", root: r }, current)).toBeNull();
  });

  it("the entry forwards to apps\\platform\\current's real folder only when that is newer and has the program", () => {
    const r = temp();
    const home = join(r, "apps", "platform");
    const exe = join(r, "AMO Platform.exe");
    expect(forwardTarget(r, exe, "0.9.4")).toBeNull();
    mkdirSync(join(home, "0.9.5"), { recursive: true });
    symlinkSync(join(home, "0.9.5"), join(home, "current"), "junction");
    // No program there yet (an install that stopped half way leaves no version folder, but be safe).
    expect(forwardTarget(r, exe, "0.9.4")).toBeNull();
    writeFileSync(join(home, "0.9.5", "AMO Platform.exe"), "new");
    expect(forwardTarget(r, exe, "0.9.4")).toBe(join(home, "0.9.5", "AMO Platform.exe"));
    expect(forwardTarget(r, exe, "0.9.5")).toBeNull();
    expect(forwardTarget(r, exe, "0.9.10")).toBeNull();
    // Its own arguments go along (the test channel, the tray-only start at login); --after names the entry.
    expect(forwardArgs(["--channel", "test", "--hidden", "--after=3"], 77)).toEqual(["--channel", "test", "--hidden", "--after=77"]);
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
    expect(stand({ place: "outer", installed: null, available: "0.9.2" })).toBe("update");
    expect(stand({ installed: "0.9.2", available: "0.9.2", installedThisRun: true })).toBe("restart");
    expect(stand({ place: "outer", installed: "0.9.2", available: "0.9.2", installedThisRun: true })).toBe("restart");
    // The entry could not forward to a newer one in apps\platform: that one first, even when the channel is newer still.
    expect(stand({ place: "outer", installed: "0.9.2", available: "0.9.3" })).toBe("newer-here");
    expect(stand({ place: "outer", installed: "0.9.0", available: "0.9.1" })).toBe("latest");
  });

  it("restart arguments keep --channel and add --after", () => {
    expect(restartArgs(["C:\\x\\AMO Platform.exe", "--channel", "test", "--hidden", "--after=12"], 40)).toEqual(["--channel", "test", "--after=40"]);
    expect(restartArgs(["electron", "main.js", "--channel=stable"], 7)).toEqual(["--channel=stable", "--after=7"]);
    expect(afterPid(["x", "--after=1234"])).toBe(1234);
    expect(afterPid(["x", "--after=nope"])).toBeNull();
    expect(afterPid(["x"])).toBeNull();
  });
});

describe("Platform's own update against the server", () => {
  const fake: Protector = { protect: async (t) => Buffer.from(t).toString("base64"), unprotect: async (d) => Buffer.from(d, "base64").toString() };
  let server: FakePlatformServer;
  const runtime = "electron runtime, the same file in every tool";
  beforeAll(async () => {
    server = await startFakePlatformServer({ users: { 小王: "secret" } });
    // A runtime shared with a tool (共用 Electron): the platform's update links it instead of downloading it.
    server.publish("notes", "1.0.0", { "AMO Notes.exe": runtime, "resources/app.txt": "notes" }, { exe: "AMO Notes.exe" });
    server.publish("platform", "0.9.2", { "AMO Platform.exe": runtime, "resources/app/package.json": '{"version":"0.9.2"}', "resources/app/main.js": "platform 0.9.2", "使用说明.txt": "0.9.2" }, { exe: "AMO Platform.exe", notes: "- 平台能自己更新了" });
  });
  afterAll(() => server.close());

  /** The zip unpacked at <temp>\TOOLS\AMO Platform: 0.9.1's entry, with a file of the person's own beside it. */
  function unpack(r: string): string {
    const dir = join(r, "TOOLS", "AMO Platform");
    mkdirSync(join(dir, "resources", "app", "old"), { recursive: true });
    writeFileSync(join(dir, "AMO Platform.exe"), "electron of 0.9.1");
    writeFileSync(join(dir, "resources", "app", "package.json"), '{"version":"0.9.1"}');
    writeFileSync(join(dir, "resources", "app", "main.js"), "platform 0.9.1");
    writeFileSync(join(dir, "resources", "app", "old", "gone-in-0.9.2.js"), "old");
    writeFileSync(join(dir, "使用说明.txt"), "0.9.1");
    writeFileSync(join(dir, "我的笔记.txt"), "mine");
    return dir;
  }

  function make(selfExe: string | null, version = "0.9.1", extra: Partial<PlatformOptions> = {}, localHome = false) {
    const r = root || temp();
    // No AMO_LOCAL_HOME: the root comes from where the program is; %LOCALAPPDATA% in the temp folder all the same.
    const env: Record<string, string | undefined> = { AMO_HOME: join(r, "roaming"), LOCALAPPDATA: join(r, "localappdata"), PATH: process.env.PATH, AMO_PLATFORM_UI_DIR: "X:\\ui", ELECTRON_RUN_AS_NODE: "1", ...(localHome ? { AMO_LOCAL_HOME: join(r, "local") } : {}) };
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
      rootDrive: async () => "local",
      ...extra,
    });
    return { platform, env, restarts, loginItems };
  }

  it("unpacked: tools and the platform's update go into <root>\\apps; 重启平台 starts apps\\platform's real folder; starting with Windows stays on the entry", async () => {
    const r = temp();
    const unpacked = unpack(r);
    const apps = join(unpacked, "apps");
    const { platform, restarts, loginItems, env } = make(join(unpacked, "AMO Platform.exe"));
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    await platform.setOpenAtLogin(true);
    expect(loginItems.at(-1)).toEqual([true, join(unpacked, "AMO Platform.exe")]);
    await platform.install("notes");
    expect(JSON.parse(readFileSync(join(env.AMO_HOME!, "programs.json"), "utf8")).tools.notes).toMatchObject({ dir: join(apps, "notes", "current") });
    expect(existsSync(join(apps, "file-index.json"))).toBe(true);
    // Nothing in AppData but the profile's place (not made here: Electron makes it).
    expect(existsSync(join(r, "localappdata", "AMO", "apps"))).toBe(false);

    let v = platform.view();
    expect(v.root).toEqual({ path: unpacked, writable: true, drive: "local" });
    expect(v.dirs).toMatchObject({ root: unpacked, apps });
    expect(v.self).toMatchObject({ place: "outer", dir: unpacked, entry: join(unpacked, "AMO Platform.exe"), entryState: null, standing: "update", available: "0.9.2", installed: null, notes: "- 平台能自己更新了", home: join(apps, "platform") });
    expect(v.tools.map((t) => t.id)).toEqual(["notes"]);
    expect(JSON.parse(readFileSync(join(env.AMO_HOME!, "platform.json"), "utf8"))).toMatchObject({ root: unpacked });

    await platform.updateSelf();
    v = platform.view();
    expect(v.self).toMatchObject({ standing: "restart", installed: "0.9.2", task: null });
    expect(v.self.result).toEqual({ tone: "ok", text: "已装好 0.9.2（1 个文件本机已经有了，没有重新下载）" });
    expect(readFileSync(join(apps, "platform", "0.9.2", "resources", "app", "main.js"), "utf8")).toBe("platform 0.9.2");
    // The entry itself is not touched by the update: it is the program running.
    expect(readFileSync(join(unpacked, "AMO Platform.exe"), "utf8")).toBe("electron of 0.9.1");
    expect(loginItems.at(-1)).toEqual([true, join(unpacked, "AMO Platform.exe")]);

    await platform.restartSelf();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({ file: join(apps, "platform", "0.9.2", "AMO Platform.exe"), cwd: join(apps, "platform", "0.9.2"), args: ["--channel", "stable", "--after=4321"] });
    expect(restarts[0]!.env).toMatchObject({ AMO_HOME: env.AMO_HOME });
    expect(restarts[0]!.env.AMO_PLATFORM_UI_DIR).toBeUndefined();
    expect(restarts[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // An old entry started now would forward there.
    expect(forwardTarget(unpacked, join(unpacked, "AMO Platform.exe"), "0.9.1")).toBe(join(apps, "platform", "0.9.2", "AMO Platform.exe"));
  });

  it("started from apps\\platform\\0.9.2: the entry's files become 0.9.2's (links, old ones gone, apps and the person's files untouched); the entry then forwards no more", async () => {
    const r = temp();
    const unpacked = unpack(r);
    const apps = join(unpacked, "apps");
    const first = make(join(unpacked, "AMO Platform.exe"));
    await first.platform.init();
    await first.platform.login(server.url, "小王", "secret");
    await first.platform.setOpenAtLogin(true);
    await first.platform.install("notes");
    await first.platform.updateSelf();
    const notesExe = join(apps, "notes", "1.0.0", "AMO Notes.exe");
    const notesBefore = readFileSync(notesExe, "utf8");

    const after = make(join(apps, "platform", "0.9.2", "AMO Platform.exe"), "0.9.2");
    await after.platform.init();
    expect(after.platform.lastEntryRefresh).toMatchObject({ error: null, removed: 1 });
    const v = after.platform.view();
    expect(v.account).toMatchObject({ name: "小王" });
    expect(v.dirs.root).toBe(unpacked);
    expect(v.self).toMatchObject({ place: "installed", standing: "latest", installed: "0.9.2", entry: join(unpacked, "AMO Platform.exe"), entryState: "current" });
    // Hard links of the version's files, not copies; the version file says 0.9.2 (the forwarding compares it).
    for (const f of ["AMO Platform.exe", "resources/app/main.js", "resources/app/package.json", "使用说明.txt"]) expect(ino(join(unpacked, ...f.split("/")))).toBe(ino(join(apps, "platform", "0.9.2", ...f.split("/"))));
    expect(JSON.parse(readFileSync(join(unpacked, "resources", "app", "package.json"), "utf8")).version).toBe("0.9.2");
    expect(existsSync(join(unpacked, "resources", "app", "old"))).toBe(false);
    expect(readFileSync(join(unpacked, "我的笔记.txt"), "utf8")).toBe("mine");
    // The shared runtime: the 便签's file (the same data as the entry's exe now) is unchanged.
    expect(readFileSync(notesExe, "utf8")).toBe(notesBefore);
    expect(ino(join(unpacked, "AMO Platform.exe"))).toBe(ino(notesExe));
    expect(readFileSync(join(apps, "notes", "current", "resources", "app.txt"), "utf8")).toBe("notes");
    // Starting with Windows on the entry; double-clicked now it runs itself.
    expect(after.loginItems.at(-1)).toEqual([true, join(unpacked, "AMO Platform.exe")]);
    expect(forwardTarget(unpacked, join(unpacked, "AMO Platform.exe"), "0.9.2")).toBeNull();
    // A second start: nothing to change.
    const again = make(join(apps, "platform", "current", "AMO Platform.exe"), "0.9.2");
    await again.platform.init();
    expect(again.platform.lastEntryRefresh).toEqual({ changed: 0, removed: 0, error: null });
  });

  it("a folder it cannot write to: nothing installed or updated, and the view says so; a network drive is only said", async () => {
    const r = temp();
    const unpacked = unpack(r);
    const { platform } = make(join(unpacked, "AMO Platform.exe"), "0.9.1", { rootWritable: () => false, rootDrive: async () => "network" });
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    expect(platform.view().root).toEqual({ path: unpacked, writable: false, drive: "network" });
    await platform.install("notes");
    expect(platform.view().tools.find((t) => t.id === "notes")?.result).toEqual({ tone: "error", text: `这个文件夹不能写入（${unpacked}），装不了也更新不了。把整个文件夹移到能写的位置（比如 D:\\TOOLS）再打开。` });
    await platform.updateSelf();
    expect(platform.view().self.result?.tone).toBe("error");
    expect(existsSync(join(unpacked, "apps"))).toBe(false);
  });

  it("development: no update, no restart, nothing installed; AMO_LOCAL_HOME is the folder", async () => {
    const { platform, restarts } = make(null, "0.9.1", {}, true);
    await platform.init();
    await platform.login(server.url, "小王", "secret");
    expect(platform.view().self).toMatchObject({ place: "dev", dir: null, entry: null, standing: "dev", available: "0.9.2" });
    expect(platform.view().dirs.root).toBe(join(root, "local"));
    await platform.updateSelf();
    expect(platform.view().self.result).toEqual({ tone: "warn", text: "这是从源码启动的开发版，不自己更新。" });
    await platform.restartSelf();
    expect(restarts).toEqual([]);
    expect(existsSync(join(root, "local", "apps", "platform"))).toBe(false);
  });
});
