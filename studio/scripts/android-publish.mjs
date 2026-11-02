// The Android app's builds on the team server (2026-10-31, the user: the app updates itself from there). Not a platform
// tool — the platform would offer it to install on Windows — but beside them in the platform dir:
//   android/<AMO-Studio-Android-<version>.apk>   the newest few builds
//   android/latest.json                          { version, versionCode, file, size, sha256, notes, publishedAt }
// The relay service hands both out to people signed in (packages/relay/src/platform.ts); the app compares versionCode
// with its own. `relay-mac.mjs android-publish` sends a build there; the steps here are what it and its test share.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sectionOf, studio } from "./amo-tools.mjs";

// studio/mobile since 2026-11-02 (was studio/android): the Kotlin Multiplatform project the iOS app shares.
export const ANDROID = join(studio, "mobile");
export const APP_ID = "dev.amo.studio";
/** The APK build.ps1 makes by default. */
export const DEFAULT_APK = join(ANDROID, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
/** Builds kept on the server: the newest few, enough to go back one by hand. */
export const KEEP_APKS = 3;

/** versionName and versionCode as app/build.gradle.kts sets them. */
export function gradleVersion(root = ANDROID) {
  const text = readFileSync(join(root, "app", "build.gradle.kts"), "utf8");
  const name = /versionName\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const code = Number(/versionCode\s*=\s*(\d+)/.exec(text)?.[1]);
  if (!name || !code) throw new Error("mobile/app/build.gradle.kts 里找不到 versionName / versionCode");
  return { version: name, versionCode: code };
}

/** The mobile/CHANGELOG.md section of `version`, or null. */
export function androidNotes(version, root = ANDROID) {
  const file = join(root, "CHANGELOG.md");
  return existsSync(file) ? sectionOf(readFileSync(file, "utf8"), version) : null;
}

/** The SDK's newest aapt, to read what an APK says it is; null when there is no SDK here. */
export function findAapt(env = process.env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : null);
  const tools = sdk ? join(sdk, "build-tools") : null;
  if (!tools || !existsSync(tools)) return null;
  const exe = process.platform === "win32" ? "aapt.exe" : "aapt";
  const dirs = readdirSync(tools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const d of dirs) if (existsSync(join(tools, d, exe))) return join(tools, d, exe);
  return null;
}

/** package name, versionCode and versionName from an APK's `aapt dump badging`. */
export function apkBadging(apk, aapt = findAapt()) {
  if (!aapt) throw new Error("找不到 Android SDK 的 aapt（设 ANDROID_HOME），没法核对安装包的版本");
  const r = spawnSync(aapt, ["dump", "badging", apk], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`aapt 读不了 ${apk}：${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return parseBadging(r.stdout);
}

export function parseBadging(text) {
  const line = /^package:(.*)$/m.exec(text)?.[1] ?? "";
  const field = (k) => new RegExp(`${k}='([^']*)'`).exec(line)?.[1] ?? null;
  return { id: field("name"), versionCode: Number(field("versionCode")), version: field("versionName") };
}

export const apkName = (version) => `AMO-Studio-Android-${version}.apk`;

/**
 * What to publish: the APK checked against build.gradle.kts (a stale build is refused), its notes from CHANGELOG.md
 * (`notes` overrides), and latest.json's content. `badging` is apkBadging's answer (tests give their own).
 */
export function androidRelease({ apk = DEFAULT_APK, notes, root = ANDROID, badging, now = new Date() } = {}) {
  if (!existsSync(apk)) throw new Error(`没有安装包 ${apk}：先在 android 目录里 ./build.ps1`);
  const { version, versionCode } = gradleVersion(root);
  const b = badging ?? apkBadging(apk);
  if (b.id !== APP_ID) throw new Error(`${apk} 不是 AMO Studio 安卓版（包名 ${b.id}）`);
  if (b.versionCode !== versionCode || b.version !== version) throw new Error(`${apk} 是 ${b.version}（${b.versionCode}）打的，build.gradle.kts 现在是 ${version}（${versionCode}）：先重新 ./build.ps1`);
  const text = (notes ?? androidNotes(version, root))?.trim();
  if (!text) throw new Error(`mobile/CHANGELOG.md 里没有 ${version} 这一节：写上再发布，或者用 --notes "…"`);
  const data = readFileSync(apk);
  const latest = { version, versionCode, file: apkName(version), size: data.length, sha256: createHash("sha256").update(data).digest("hex"), notes: text, publishedAt: now.toISOString() };
  return { apk, latest };
}

/**
 * The shell code that puts a build in place on the server, run with the APK and latest.json already in `incoming`:
 * the APK first, then latest.json renamed in (it never names a file that is not there yet), then all but the newest
 * KEEP_APKS builds removed — never the one latest.json names.
 */
export function placeScript(incoming, dir, file, keep = KEEP_APKS) {
  return `IN="${incoming}"; OUT="${dir}"; mkdir -p "$OUT"
mv -f "$IN/${file}" "$OUT/${file}"
mv -f "$IN/latest.json" "$OUT/latest.json.new" && mv -f "$OUT/latest.json.new" "$OUT/latest.json"
rm -rf "$IN"
cd "$OUT"; ls -t *.apk 2>/dev/null | grep -vx "${file}" | tail -n +${keep} | while read -r f; do rm -f "$f"; echo "removed $f"; done
ls -l "$OUT"`;
}
