import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sectionOf } from "./amo-tools.mjs";
import { LocalTarget, ShellTarget, compareVersions, promote, publish, status } from "./platform-publish.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name) => {
  const d = mkdtempSync(join(tmpdir(), `amo-${name}-`));
  dirs.push(d);
  return d;
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** A program folder shaped like package-portable's: the exe, resources/app/package.json with the version, more files. */
function programFolder(root, version, files) {
  const dir = join(root, "AMO Notes");
  rmSync(dir, { recursive: true, force: true });
  const all = { "AMO Notes.exe": "exe", "resources/app/package.json": JSON.stringify({ version }), "使用说明.txt": "便签", ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function objectsIn(platform) {
  const root = join(platform, "objects");
  return existsSync(root) ? readdirSync(root).flatMap((p) => readdirSync(join(root, p))).sort() : [];
}

async function scenario(target, platformDir) {
  const release = temp("release");
  // 1. 0.9.0 to the test channel: every file is new.
  let dir = programFolder(release, "0.9.0", { "resources/app/main.js": "v1", "resources/app/same.js": "same", "locales/zh-CN.pak": "same" });
  const first = await publish(target, { id: "notes", dir, version: "0.9.0", notes: "- 第一版", channel: "test" });
  expect(first.existed).toBe(false);
  // Two files with the same content are one object.
  expect(first.uploaded.length).toBe(5);
  expect(first.manifest).toMatchObject({ tool: "notes", name: "AMO Notes", version: "0.9.0", exe: "AMO Notes.exe", notes: "- 第一版" });
  expect(first.manifest.files.map((f) => f.path)).toEqual(["AMO Notes.exe", "locales/zh-CN.pak", "resources/app/main.js", "resources/app/package.json", "resources/app/same.js", "使用说明.txt"]);
  expect(first.manifest.files.find((f) => f.path === "resources/app/main.js")).toEqual({ path: "resources/app/main.js", size: 2, sha256: sha("v1") });
  expect(typeof first.manifest.builtAt).toBe("number");
  expect(await target.readChannels()).toEqual({ stable: {}, test: { notes: "0.9.0" } });
  if (platformDir) expect(objectsIn(platformDir)).toEqual([...new Set(first.manifest.files.map((f) => f.sha256))].sort());

  // The same version again with the same files: only the channel moves; with other files: refused.
  const again = await publish(target, { id: "notes", dir, version: "0.9.0", notes: "- 第一版", channel: "test" });
  expect(again).toMatchObject({ existed: true, uploaded: [] });
  writeFileSync(join(dir, "resources/app/main.js"), "changed");
  await expect(publish(target, { id: "notes", dir, version: "0.9.0", notes: "x" })).rejects.toThrow(/已经发布过，而且文件不一样/);
  // A folder built for another version than the one asked.
  await expect(publish(target, { id: "notes", dir, version: "0.9.1", notes: "x" })).rejects.toThrow(/0.9.0 打的包/);

  // 2. 0.9.1 with one file changed (and its version stamp): only those two objects go up.
  dir = programFolder(release, "0.9.1", { "resources/app/main.js": "v2", "resources/app/same.js": "same", "locales/zh-CN.pak": "same" });
  const second = await publish(target, { id: "notes", dir, version: "0.9.1", notes: "- 改了一处", channel: "test" });
  expect(second.uploaded.sort()).toEqual([sha("v2"), sha(JSON.stringify({ version: "0.9.1" }))].sort());
  expect(await target.readChannels()).toEqual({ stable: {}, test: { notes: "0.9.1" } });
  if (platformDir) expect(objectsIn(platformDir).length).toBe(7);

  // 3. promote: only a published version; stable never runs ahead of test.
  await expect(promote(target, { id: "notes", version: "0.9.2" })).rejects.toThrow(/还没有发布过/);
  expect(await promote(target, { id: "notes", version: "0.9.0" })).toEqual({ stable: { notes: "0.9.0" }, test: { notes: "0.9.1" } });
  expect(await promote(target, { id: "notes", version: "0.9.1" })).toEqual({ stable: { notes: "0.9.1" }, test: { notes: "0.9.1" } });

  // 4. platform-status.
  const text = await status(target, { tools: ["studio", "reviewer", "notes"] });
  const lines = text.split("\n");
  expect(lines[0]).toMatch(/^工具\s+稳定\s+测试\s+已发布$/);
  expect(lines).toContainEqual(expect.stringMatching(/^studio\s+-\s+-\s+-$/));
  expect(lines).toContainEqual(expect.stringMatching(/^notes\s+0\.9\.1\s+0\.9\.1\s+0\.9\.0, 0\.9\.1$/));
  expect(lines.at(-1)).toMatch(/^文件：7 个，/);
  return { first, second };
}

describe("platform publish", () => {
  it("publishes to a local platform dir: a new version sends only what changed; promote; status", async () => {
    const platform = temp("platform");
    await scenario(new LocalTarget(platform), platform);
    const manifest = JSON.parse(readFileSync(join(platform, "tools", "notes", "0.9.1.json"), "utf8"));
    expect(manifest.notes).toBe("- 改了一处");
    // Nothing half-written is left behind.
    expect(readdirSync(platform).sort()).toEqual(["channels.json", "objects", "tools"]);
  });

  it("checks what it is given", async () => {
    const target = new LocalTarget(temp("platform"));
    const dir = programFolder(temp("release"), "0.9.0", {});
    await expect(publish(target, { id: "relay", dir, version: "0.9.0", notes: "x" })).rejects.toThrow(/不通过平台发布/);
    await expect(publish(target, { id: "nope", dir, version: "0.9.0", notes: "x" })).rejects.toThrow(/unknown tool/);
    await expect(publish(target, { id: "notes", dir, version: "0.9", notes: "x" })).rejects.toThrow(/版本号不对/);
    await expect(publish(target, { id: "notes", dir, version: "0.9.0", notes: "x", channel: "beta" })).rejects.toThrow(/通道/);
    await expect(publish(target, { id: "notes", dir, version: "0.9.0", notes: " " })).rejects.toThrow(/没有改动说明/);
    await expect(publish(target, { id: "studio", dir, version: "0.9.0", notes: "x" })).rejects.toThrow(/没有 AMO Studio.exe/);
  });

  it("reads a version's section of a CHANGELOG", () => {
    const md = "# 改动\n\n## 0.9.10（2026-11-01）\n\n- 十\n\n## 0.9.1（2026-10-29）\n\n- 一\n- 二\n\n## 0.9.0（2026-10-22）\n\n- 零\n";
    expect(sectionOf(md, "0.9.1")).toBe("- 一\n- 二");
    expect(sectionOf(md, "0.9.0")).toBe("- 零");
    expect(sectionOf(md, "0.9")).toBeNull();
    expect(sectionOf(md, "0.9.2")).toBeNull();
  });

  it("orders versions like semver", () => {
    expect(["0.9.10", "0.9.2", "0.9.2-test.1", "1.0.0", "0.9.2-test.10", "0.9.2-test.2"].sort(compareVersions)).toEqual(["0.9.2-test.1", "0.9.2-test.2", "0.9.2-test.10", "0.9.2", "0.9.10", "1.0.0"]);
  });

  // The scripts relay-mac.mjs sends over SSH, run by a local bash (Git Bash on Windows) against a temp folder.
  const bash = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => existsSync(p)) : "/bin/bash";
  it.skipIf(!bash)("publishes through bash the way it does over SSH", async () => {
    const platform = temp("platform");
    const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);
    // Git Bash has no shasum outside a login shell; the Mac has it.
    const shim = 'command -v shasum >/dev/null || shasum() { shift 2; sha256sum "$@"; }\n';
    const run = (script) => {
      const res = spawnSync(bash, ["-s"], { input: shim + script, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`bash: exit ${res.status}: ${res.stderr}`);
      return res.stdout;
    };
    const upload = (dir, entries, target) =>
      new Promise((done, fail) => {
        const tar = spawn(bash, ["-c", `tar -cf - ${entries.map((e) => `'${e}'`).join(" ")}`], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
        const into = spawn(bash, ["-c", `rm -rf "${target}" && mkdir -p "${target}" && tar -xf - -C "${target}"`], { stdio: ["pipe", "inherit", "inherit"] });
        tar.stdout.pipe(into.stdin);
        into.on("close", (code) => (code === 0 ? done() : fail(new Error(`upload: exit ${code}`))));
      });
    await scenario(new ShellTarget({ run, upload, root: posix(platform) }), platform);
    expect(readdirSync(platform).sort()).toEqual(["channels.json", "objects", "tools"]);
    expect(JSON.parse(readFileSync(join(platform, "tools", "notes", "0.9.0.json"), "utf8")).notes).toBe("- 第一版");
  });
});
