import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { npmNativeCommand } from "./command.js";

let root: string | undefined;
afterEach(() => {
  if (root) removeTempDir(root);
  root = undefined;
});

function fakeInstall(nested: boolean): string {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-codex-"));
  mkdirSync(join(root, "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(join(root, "@openai", "codex", "bin", "codex.js"), "");
  const pkg = nested ? join(root, "@openai", "codex", "node_modules", "@openai", "codex-win32-x64") : join(root, "@openai", "codex-win32-x64");
  const bin = join(pkg, "vendor", "x86_64-pc-windows-msvc", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex.exe"), "");
  return join(bin, "codex.exe");
}

describe("npmNativeCommand", () => {
  it("runs the platform binary of the npm package directly, with the env its launcher script sets", () => {
    const exe = fakeInstall(false);
    const cmd = npmNativeCommand(root!, "win32-x64")!;
    expect(cmd).toMatchObject({ command: exe, prefixArgs: [], source: "npm-global" });
    expect(cmd.env.CODEX_MANAGED_BY_NPM).toBe("1");
    expect(cmd.env.CODEX_MANAGED_PACKAGE_ROOT).toMatch(/codex$/);
  });

  it("finds a binary nested under the package, and gives up on other platforms", () => {
    const exe = fakeInstall(true);
    expect(npmNativeCommand(root!, "win32-x64")?.command).toBe(exe);
    expect(npmNativeCommand(root!, "linux-x64")).toBeNull();
  });
});
