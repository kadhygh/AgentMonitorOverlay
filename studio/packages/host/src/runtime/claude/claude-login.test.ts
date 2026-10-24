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
  it("is the local Claude Code login until the person picks otherwise; test runs default to the token", () => {
    expect(readClaudeLogin(store, {})).toBe("local");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1" })).toBe("token");
    writeClaudeLogin(store, "token");
    expect(readClaudeLogin(store, {})).toBe("token");
    writeClaudeLogin(store, "local");
    expect(readClaudeLogin(store, { AMO_STUDIO_TEST: "1" })).toBe("local");
  });
});
