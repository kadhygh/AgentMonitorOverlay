import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, sha256Of, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { PlatformClient } from "./client.js";
import { Installer, type ProgramsFile } from "./installer.js";
import { channelVersion, checkManifest, compareVersions, safeParts } from "./manifest.js";

let server: FakePlatformServer;
let client: PlatformClient;
let root = "";

beforeAll(async () => {
  server = await startFakePlatformServer({ users: { 小王: "secret" } });
  const res = await fetch(`${server.url}/api/login`, { method: "POST", body: JSON.stringify({ name: "小王", password: "secret" }) });
  client = new PlatformClient(server.url, ((await res.json()) as { key: string }).key);
});
afterAll(() => server.close());
afterEach(() => root && removeTempDir(root));

function setup(running: () => boolean = () => false) {
  root = mkdtempSync(join(tmpdir(), "amo-platform-installer-"));
  const installer = new Installer({ appsDir: join(root, "apps"), programsFile: join(root, "home", "programs.json"), isRunning: async () => running() });
  return installer;
}
const programs = () => JSON.parse(readFileSync(join(root, "home", "programs.json"), "utf8")) as ProgramsFile;
const objectGets = () => server.requests.filter((r) => r.startsWith("GET /platform/objects/")).length;
const big = (seed: string, kb = 64) => Buffer.alloc(kb * 1024, seed);

/** Three versions of a pretend tool: the big runtime stays, the app code changes. */
function publishThree(tool: string) {
  const files = (v: string) => ({ "Tool.exe": big("E"), "resources/app.js": `console.log("${v}")`, "resources/data/same.txt": "same in every version", "LICENSE.txt": "MIT" });
  server.publish(tool, "1.0.0", files("1.0.0"), { exe: "Tool.exe", notes: "第一版" });
  server.publish(tool, "1.1.0", files("1.1.0"), { exe: "Tool.exe", notes: "第二版", channel: null });
  server.publish(tool, "1.2.0", { ...files("1.2.0"), "resources/new.txt": "new" }, { exe: "Tool.exe", notes: "第三版", channel: null });
}

describe("Installer", () => {
  it("installs a version: the files, `current` as a junction to it, its record and programs.json", async () => {
    const inst = setup();
    publishThree("alpha");
    const seen: string[] = [];
    const r = await inst.install("alpha", "1.0.0", client, (p) => seen.push(p.phase));
    expect(r).toMatchObject({ version: "1.0.0", previous: null, reused: 0, downloaded: 4, switchedOnly: false });
    const dir = join(root, "apps", "alpha");
    expect(readFileSync(join(dir, "1.0.0", "resources", "app.js"), "utf8")).toBe('console.log("1.0.0")');
    expect(realpathSync(join(dir, "current"))).toBe(realpathSync(join(dir, "1.0.0")));
    expect(inst.currentVersion("alpha")).toBe("1.0.0");
    expect(programs().tools.alpha).toEqual({ version: "1.0.0", dir: join(dir, "current"), exe: "Tool.exe" });
    expect(seen).toEqual(expect.arrayContaining(["manifest", "linking", "downloading", "switching"]));
    // Nothing half-made left behind.
    expect(readdirSync(dir).sort()).toEqual(["1.0.0", "1.0.0.json", "current"]);
  });

  it("an update hard-links the files that did not change and downloads only the rest", async () => {
    const inst = setup();
    publishThree("beta");
    await inst.install("beta", "1.0.0", client);
    const before = objectGets();
    const r = await inst.install("beta", "1.1.0", client);
    expect(r).toMatchObject({ version: "1.1.0", previous: "1.0.0", reused: 3, downloaded: 1 });
    expect(objectGets() - before).toBe(1);
    const dir = join(root, "apps", "beta");
    // The same file on disk (one inode, two names), not a copy.
    const a = statSync(join(dir, "1.0.0", "Tool.exe"), { bigint: true });
    const b = statSync(join(dir, "1.1.0", "Tool.exe"), { bigint: true });
    expect(b.ino).toBe(a.ino);
    expect(Number(b.nlink)).toBe(2);
    expect(readFileSync(join(dir, "1.1.0", "resources", "app.js"), "utf8")).toBe('console.log("1.1.0")');
    expect(inst.currentVersion("beta")).toBe("1.1.0");
    expect(programs().tools.beta!.version).toBe("1.1.0");
  });

  it("a file whose sha256 does not match is not installed: no version folder, `current` and programs.json unchanged", async () => {
    const inst = setup();
    publishThree("gamma");
    await inst.install("gamma", "1.0.0", client);
    server.corruptObject(sha256Of('console.log("1.1.0")'));
    await expect(inst.install("gamma", "1.1.0", client)).rejects.toMatchObject({ code: "checksum" });
    const dir = join(root, "apps", "gamma");
    expect(readdirSync(dir).sort()).toEqual(["1.0.0", "1.0.0.json", "current"]);
    expect(inst.currentVersion("gamma")).toBe("1.0.0");
    expect(programs().tools.gamma!.version).toBe("1.0.0");
    // The next try (a good download) works.
    await inst.install("gamma", "1.1.0", client);
    expect(inst.currentVersion("gamma")).toBe("1.1.0");
  });

  it("a download that breaks off half way leaves no half version behind", async () => {
    const inst = setup();
    publishThree("delta");
    server.breakObject(sha256Of(big("E")));
    await expect(inst.install("delta", "1.0.0", client)).rejects.toMatchObject({ code: expect.stringMatching(/unreachable|checksum/) });
    const dir = join(root, "apps", "delta");
    expect(readdirSync(dir)).toEqual([]);
    expect(inst.currentVersion("delta")).toBeNull();
    expect(existsSync(join(root, "home", "programs.json"))).toBe(false);
  });

  it("switches `current` while a file of the old version is open (a program still running from it)", async () => {
    const inst = setup();
    publishThree("eps");
    await inst.install("eps", "1.0.0", client);
    const fd = openSync(join(root, "apps", "eps", "1.0.0", "resources", "app.js"), "r");
    try {
      await inst.install("eps", "1.1.0", client);
      expect(inst.currentVersion("eps")).toBe("1.1.0");
    } finally {
      closeSync(fd);
    }
  });

  it("keeps the last 2 versions used; 回滚 goes to the other one and back", async () => {
    const inst = setup();
    publishThree("zeta");
    await inst.install("zeta", "1.0.0", client);
    await inst.install("zeta", "1.1.0", client);
    const r = await inst.install("zeta", "1.2.0", client);
    expect(r.leftover).toEqual([]);
    const dir = join(root, "apps", "zeta");
    expect(readdirSync(dir).sort()).toEqual(["1.1.0", "1.1.0.json", "1.2.0", "1.2.0.json", "current"]);
    expect(inst.versions("zeta").map((v) => v.version)).toEqual(["1.2.0", "1.1.0"]);
    // 1.2.0 brought its files over from 1.1.0, which itself had them from 1.0.0: removing 1.0.0 did not touch them.
    expect(statSync(join(dir, "1.2.0", "Tool.exe")).size).toBe(64 * 1024);

    expect(inst.rollbackTarget("zeta")?.version).toBe("1.1.0");
    expect(inst.rollback("zeta")).toEqual({ version: "1.1.0", from: "1.2.0" });
    expect(inst.currentVersion("zeta")).toBe("1.1.0");
    expect(programs().tools.zeta!.version).toBe("1.1.0");
    expect(readFileSync(join(dir, "current", "resources", "app.js"), "utf8")).toBe('console.log("1.1.0")');
    expect(inst.rollbackTarget("zeta")?.version).toBe("1.2.0");
    // Installing a kept version only moves `current`.
    const back = await inst.install("zeta", "1.2.0", client);
    expect(back.switchedOnly).toBe(true);
    expect(inst.currentVersion("zeta")).toBe("1.2.0");
  });

  it("回滚 with only one version says so", async () => {
    const inst = setup();
    publishThree("eta");
    await inst.install("eta", "1.0.0", client);
    expect(() => inst.rollback("eta")).toThrow(/没有可以回去的上一版/);
  });

  it("uninstall: refused while it runs; otherwise every version, `current` and its programs.json entry go", async () => {
    let running = true;
    const inst = setup(() => running);
    publishThree("theta");
    publishThree("iota");
    await inst.install("theta", "1.0.0", client);
    await inst.install("theta", "1.1.0", client);
    await inst.install("iota", "1.0.0", client);
    await expect(inst.uninstall("theta", "Theta")).rejects.toMatchObject({ code: "running", message: "Theta 正在运行，先关掉它再卸载。" });
    expect(inst.currentVersion("theta")).toBe("1.1.0");
    running = false;
    await inst.uninstall("theta");
    expect(existsSync(join(root, "apps", "theta"))).toBe(false);
    expect(programs().tools.theta).toBeUndefined();
    expect(programs().tools.iota!.version).toBe("1.0.0");
    // The other tool's files are untouched (removing `current` never followed the junction).
    expect(readFileSync(join(root, "apps", "iota", "current", "LICENSE.txt"), "utf8")).toBe("MIT");
  });

  it("repair after a stop half way: a .partial folder, a folder without its record, a switch cut short", async () => {
    const inst = setup();
    publishThree("kappa");
    await inst.install("kappa", "1.0.0", client);
    const dir = join(root, "apps", "kappa");
    mkdirSync(join(dir, ".partial-1.1.0-1-x", "resources"), { recursive: true });
    mkdirSync(join(dir, "1.1.0"));
    // The old `current` removed, the new one not yet renamed into place.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "current"));
    symlinkSync(join(dir, "1.0.0"), join(dir, "current.next"), "junction");
    expect(inst.currentVersion("kappa")).toBeNull();
    inst.repair("kappa");
    expect(readdirSync(dir).sort()).toEqual(["1.0.0", "1.0.0.json", "current"]);
    expect(inst.currentVersion("kappa")).toBe("1.0.0");
    expect(basename(realpathSync(join(dir, "current")))).toBe("1.0.0");
  });

  it("refuses a manifest whose paths leave the program folder", async () => {
    const inst = setup();
    const m = server.publish("lambda", "1.0.0", { "a.exe": "x" }, { exe: "a.exe" });
    expect(() => checkManifest({ ...m, files: [{ path: "../evil.dll", size: 1, sha256: m.files[0]!.sha256 }, ...m.files] }, "lambda", "1.0.0")).toThrow(/文件路径不对/);
    expect(() => checkManifest({ ...m, exe: "C:/Windows/x.exe" }, "lambda", "1.0.0")).toThrow(/主程序路径不对/);
    expect(() => checkManifest({ ...m, version: "2.0.0" }, "lambda", "1.0.0")).toThrow();
    for (const bad of ["..", "a/../b", "/abs", "a\\b", "c:x", "a//b", "con.", ""]) expect(safeParts(bad), bad).toBeNull();
    expect(safeParts("resources/app.asar")).toEqual(["resources", "app.asar"]);
    writeFileSync(join(root, "x"), "");
    expect(inst.versions("lambda")).toEqual([]);
  });
});

describe("versions and channels", () => {
  it("compares versions by number, a pre-release before its release", () => {
    expect(compareVersions("0.9.10", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(["0.9.2", "0.10.0", "0.9.10"].sort(compareVersions)).toEqual(["0.9.2", "0.9.10", "0.10.0"]);
  });

  it("the test channel offers the newer of test and stable; stable only its own", () => {
    const ch = { stable: { studio: "0.9.0", notes: "0.9.3" }, test: { studio: "0.9.1", notes: "0.9.2" } };
    expect(channelVersion(ch, "stable", "studio")).toBe("0.9.0");
    expect(channelVersion(ch, "test", "studio")).toBe("0.9.1");
    expect(channelVersion(ch, "test", "notes")).toBe("0.9.3");
    expect(channelVersion({ stable: {}, test: { x: "1.0.0" } }, "stable", "x")).toBeNull();
    expect(channelVersion({ stable: { x: "1.0.0" }, test: {} }, "test", "x")).toBe("1.0.0");
  });
});
