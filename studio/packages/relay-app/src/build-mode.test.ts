import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newShellText, readBuildMode, stableExe } from "./build-mode.js";

let root = "";
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

/** A program folder as package-portable.mjs lays it out: <dir>/AMO Relay.exe, resources/app/package.json, the dist. */
function programFolder(dir: string, appPackage: string | null): string {
  const dist = join(dir, "resources", "app", "packages", "relay-app", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dir, "AMO Relay.exe"), "");
  if (appPackage !== null) writeFileSync(join(dir, "resources", "app", "package.json"), appPackage);
  return dist;
}

describe("the shell's build mode", () => {
  it("reads amoBuild.mode from resources/app/package.json; anything else is a dev build", () => {
    root = mkdtempSync(join(tmpdir(), "relay-build-mode-"));
    expect(readBuildMode(programFolder(join(root, "p"), JSON.stringify({ version: "0.9.0", amoBuild: { mode: "platform", runtime: "44.7.0" } })))).toBe("platform");
    expect(readBuildMode(programFolder(join(root, "z"), JSON.stringify({ version: "0.9.0", amoBuild: { mode: "portable", runtime: "44.7.0" } })))).toBe("portable");
    // A folder from before the mark, the sources (studio/package.json has none), no file, a broken file.
    expect(readBuildMode(programFolder(join(root, "old"), JSON.stringify({ version: "0.1.0" })))).toBe("dev");
    expect(readBuildMode(programFolder(join(root, "none"), null))).toBe("dev");
    expect(readBuildMode(programFolder(join(root, "bad"), "{"))).toBe("dev");
  });

  it("points the MCP and the command line at the platform's `current`, which outlives the version folder", () => {
    root = mkdtempSync(join(tmpdir(), "relay-build-mode-"));
    const apps = join(root, "apps", "relay");
    programFolder(join(apps, "0.9.0"), "{}");
    const exe = join(apps, "0.9.0", "AMO Relay.exe");
    // No `current` (a folder copied elsewhere): the exe itself.
    expect(stableExe(exe, "platform")).toBe(exe);
    symlinkSync(join(apps, "0.9.0"), join(apps, "current"), "junction");
    expect(stableExe(exe, "platform")).toBe(join(apps, "current", "AMO Relay.exe"));
    // The unpacked zip and the sources keep their own exe, as before.
    expect(stableExe(exe, "portable")).toBe(exe);
    expect(stableExe(exe, "dev")).toBe(exe);
  });

  it("says where a newer desktop program comes from", () => {
    expect(newShellText("platform")).toContain("在 AMO 平台的「工具」里更新 AMO 中转");
    expect(newShellText("portable")).toBe("需要重新下载客户端。");
  });
});
