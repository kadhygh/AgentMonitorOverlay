import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { androidRelease, apkName, gradleVersion, parseBadging, placeScript } from "./android-publish.mjs";

// The Android app's builds on the team server (2026-10-31): what android-publish checks before it sends one, and how it
// puts it in place — the shell script run by a local bash (Git Bash on Windows) and relay-mac's --target-dir.

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name) => {
  const d = mkdtempSync(join(tmpdir(), `amo-${name}-`));
  dirs.push(d);
  return d;
};

/** An android folder: build.gradle.kts with the version, CHANGELOG.md, an APK. */
function androidRoot({ version = "0.1.1", code = 2, changelog = `# 改动说明\n\n## 0.1.1\n\n- 能自己更新\n\n## 0.1.0\n\n- 第一版\n` } = {}) {
  const root = temp("android");
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "build.gradle.kts"), `android {\n    defaultConfig {\n        versionCode = ${code}\n        versionName = "${version}"\n    }\n}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  const apk = join(root, "app-debug.apk");
  writeFileSync(apk, `PK apk ${version}`);
  return { root, apk };
}
const badging = (version = "0.1.1", versionCode = 2, id = "dev.amo.studio") => ({ id, version, versionCode });

describe("android-publish", () => {
  it("reads the version, the APK's badging, and refuses a stale build, another app or missing notes", () => {
    const { root, apk } = androidRoot();
    expect(gradleVersion(root)).toEqual({ version: "0.1.1", versionCode: 2 });
    expect(parseBadging("package: name='dev.amo.studio' versionCode='2' versionName='0.1.1' platformBuildVersionName='16'\nsdkVersion:'28'\n")).toEqual({ id: "dev.amo.studio", versionCode: 2, version: "0.1.1" });
    const now = new Date("2026-10-31T12:00:00.000Z");
    const { latest } = androidRelease({ apk, root, badging: badging(), now });
    expect(latest).toEqual({ version: "0.1.1", versionCode: 2, file: "AMO-Studio-Android-0.1.1.apk", size: "PK apk 0.1.1".length, sha256: createHash("sha256").update("PK apk 0.1.1").digest("hex"), notes: "- 能自己更新", publishedAt: now.toISOString() });
    expect(() => androidRelease({ apk, root, badging: badging("0.1.0", 1) })).toThrow("先重新 ./build.ps1");
    expect(() => androidRelease({ apk, root, badging: badging("0.1.1", 2, "dev.other") })).toThrow("不是 AMO Studio 安卓版");
    expect(() => androidRelease({ apk: join(root, "nope.apk"), root, badging: badging() })).toThrow("先在 android 目录里 ./build.ps1");
    const bare = androidRoot({ changelog: "# 改动说明\n\n## 0.1.0\n\n- 第一版\n" });
    expect(() => androidRelease({ apk: bare.apk, root: bare.root, badging: badging() })).toThrow("CHANGELOG.md 里没有 0.1.1 这一节");
    expect(androidRelease({ apk: bare.apk, root: bare.root, badging: badging(), notes: "- 临时说明" }).latest.notes).toBe("- 临时说明");
  });

  // The script relay-mac.mjs sends over SSH, against a temp folder.
  const bash = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => existsSync(p)) : "/bin/bash";
  it.skipIf(!bash)("puts the build in place, latest.json last, and keeps the newest 3 builds — always the one it names", () => {
    const root = temp("android-server").replace(/\\/g, "/");
    const out = `${root}/platform/android`;
    mkdirSync(out, { recursive: true });
    // Older builds by time: 0.0.7 the oldest, the one that goes.
    ["0.0.7", "0.0.8", "0.0.9"].forEach((v, i) => {
      writeFileSync(join(out, apkName(v)), v);
      utimesSync(join(out, apkName(v)), 1_000 + i, 1_000 + i);
    });
    const incoming = `${root}/incoming-android`;
    mkdirSync(incoming);
    const file = apkName("0.1.1");
    writeFileSync(join(incoming, file), "new");
    writeFileSync(join(incoming, "latest.json"), JSON.stringify({ file }));
    const res = spawnSync(bash, ["-s"], { input: `set -e\n${placeScript(incoming, out, file)}`, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([apkName("0.0.8"), apkName("0.0.9"), file, "latest.json"].sort());
    expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual({ file });
    expect(existsSync(incoming)).toBe(false);
  });

  it("relay-mac.mjs android-publish --target-dir: a folder here gets the same", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "relay-mac.mjs");
    const platform = temp("android-platform");
    // relay-mac reads the real android folder; with no APK at the path given it says what to do.
    const res = spawnSync(process.execPath, [script, "android-publish", "--apk", join(platform, "none.apk"), "--target-dir", platform], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("先在 android 目录里 ./build.ps1");
    expect(existsSync(join(platform, "android"))).toBe(false);
  });
});
