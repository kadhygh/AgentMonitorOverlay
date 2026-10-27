import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { readClaudeLogin, writeClaudeLogin } from "./claude-login.js";

let root: string;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-login-"));
  store = new Store(join(root, "studio.db"));
});

afterEach(() => {
  store.close();
  removeTempDir(root);
});

describe("how the Claude subscription signs in", () => {
  it("is always the local Claude Code login; test runs use a test token unless they point CLAUDE_CONFIG_DIR at a stand-in (2026-10-27)", () => {
    expect(readClaudeLogin(store, {})).toBe("local");
    // A token chosen before the mode was removed counts for nothing.
    writeClaudeLogin(store, "token");
    expect(readClaudeLogin(store, {})).toBe("local");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1" })).toBe("token");
    writeClaudeLogin(store, "local");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1" })).toBe("local");
    store.setKv("settings:claude-login", "");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1" })).toBe("token");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1", CLAUDE_CONFIG_DIR: "D:/stand-in" })).toBe("local");
  });
});
