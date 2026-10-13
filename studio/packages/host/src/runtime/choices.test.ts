import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { CLAUDE_PERMISSIONS, claudePermissionMode, codexPermission, codexPermissions, codexWindowsSandbox } from "./choices.js";

describe("Codex permissions", () => {
  it("maps each option to an approval policy and a sandbox, defaulting to ask-every-command", () => {
    expect(codexPermission(undefined)).toEqual({ approvalPolicy: "untrusted", sandbox: "danger-full-access" });
    expect(codexPermission("full-auto")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(codexPermission("workspace-write")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPermission("nonsense")).toEqual(codexPermission("ask"));
  });

  it("marks the sandboxed options unusable under the unelevated Windows sandbox", () => {
    const broken = codexPermissions("unelevated");
    expect(broken.filter((p) => p.unavailable).map((p) => p.id)).toEqual(["workspace-write", "read-only"]);
    expect(codexPermissions(null).some((p) => p.unavailable)).toBe(false);
  });

  it("reads [windows] sandbox from a Codex config", () => {
    const home = mkdtempSync(join(tmpdir(), "amo-studio-test-codexhome-"));
    try {
      expect(codexWindowsSandbox(home)).toBeNull();
      writeFileSync(join(home, "config.toml"), 'model = "x"\nsandbox = "not-this"\n[windows]\nsandbox = "unelevated"\n[tui]\nsandbox = "nor-this"\n');
      expect(codexWindowsSandbox(home)).toBe("unelevated");
    } finally {
      removeTempDir(home);
    }
  });
});

describe("Claude permissions", () => {
  it("offers Claude Code's modes and falls back to default", () => {
    expect(CLAUDE_PERMISSIONS.map((p) => p.id)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(claudePermissionMode("plan")).toBe("plan");
    expect(claudePermissionMode(undefined)).toBe("default");
    expect(claudePermissionMode("auto")).toBe("default");
  });
});
