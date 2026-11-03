import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { ClaudeAccounts, linkShared, removeAccountDir } from "./accounts.js";

// Claude 多账号 (2026-11-03): an added account's dir links to the default one, and taking it away never touches what
// the links point to. Switching itself (with a running session) is in claude-runtime.integration.test.ts.

let root: string;
let store: Store;
let mine: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-claude-accounts-"));
  store = new Store(join(root, "studio.db"));
  mine = join(root, "my-claude");
  mkdirSync(join(mine, "skills", "one"), { recursive: true });
  writeFileSync(join(mine, "skills", "one", "SKILL.md"), "a skill");
  writeFileSync(join(mine, "CLAUDE.md"), "my rules");
  writeFileSync(join(mine, "settings.json"), '{"env":{}}');
});

afterEach(() => {
  store.close();
  removeTempDir(root);
});

const signIn = (dir: string) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.now() + 3600_000 } }));

describe("linkShared", () => {
  it("links the default dir's records and skills, copies CLAUDE.md and settings.json, and keeps them up to date", () => {
    const dir = join(root, "acct");
    linkShared(mine, dir);
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(mine, "projects"))).toBe(true);
    expect(readFileSync(join(dir, "skills", "one", "SKILL.md"), "utf8")).toBe("a skill");
    // Only what the default dir has.
    expect(existsSync(join(dir, "plugins"))).toBe(false);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("my rules");
    // A session's record written through the link lands in the default dir.
    mkdirSync(join(dir, "projects", "G--x"), { recursive: true });
    writeFileSync(join(dir, "projects", "G--x", "s.jsonl"), "{}");
    expect(existsSync(join(mine, "projects", "G--x", "s.jsonl"))).toBe(true);
    // The default dir's files win at the next start.
    writeFileSync(join(mine, "CLAUDE.md"), "new rules");
    linkShared(mine, dir);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("new rules");
  });

  it("leaves a dir that already holds something where a link would go", () => {
    const dir = join(root, "acct");
    mkdirSync(join(dir, "skills", "own"), { recursive: true });
    linkShared(mine, dir);
    expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, "skills", "own"))).toBe(true);
  });
});

describe("removeAccountDir", () => {
  it("unlinks first, so the default dir's records stay", () => {
    const accounts = join(root, "accounts");
    const dir = join(accounts, "ca-1");
    linkShared(mine, dir);
    signIn(dir);
    writeFileSync(join(mine, "projects", "keep.jsonl"), "{}");
    removeAccountDir(accounts, dir);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(mine, "projects", "keep.jsonl"))).toBe(true);
    expect(existsSync(join(mine, "skills", "one", "SKILL.md"))).toBe(true);
  });

  it("does nothing outside the accounts' folder", () => {
    removeAccountDir(join(root, "accounts"), mine);
    expect(existsSync(join(mine, "CLAUDE.md"))).toBe(true);
  });
});

describe("ClaudeAccounts", () => {
  it("starts with the person's own dir only; added accounts sign in before they can be switched to", async () => {
    signIn(mine);
    const accounts = new ClaudeAccounts(store, { defaultDir: mine, defaultExplicit: false, root: join(root, "accounts") });
    expect(accounts.state()).toMatchObject({ current: "default", accounts: [{ id: "default", isDefault: true, label: "本机默认账号", dir: mine, signedIn: true }], switchBlocked: null });
    expect(accounts.currentHome()).toEqual({ id: "default", dir: mine, explicit: false });

    const id = accounts.add("工作", { signIn: false });
    const dir = join(root, "accounts", id);
    expect(accounts.state().accounts[1]).toMatchObject({ id, label: "工作", dir, isDefault: false, signedIn: false, login: null });
    await expect(accounts.switchTo(id)).rejects.toThrow(/还没登录/);
    signIn(dir);

    // The runtime's guard: refused while a session is at work, its idle processes closed first otherwise.
    let blocked: string | null = "有 1 个 Claude 会话正在进行";
    let closed = 0;
    accounts.setGuard({ blocked: () => blocked, beforeSwitch: async () => void closed++ });
    await expect(accounts.switchTo(id)).rejects.toThrow(/正在进行/);
    blocked = null;
    await accounts.switchTo(id);
    expect(closed).toBe(1);
    expect(accounts.currentHome()).toEqual({ id, dir, explicit: true });
    expect(() => accounts.remove(id)).toThrow(/正在使用/);
    expect(() => accounts.remove("default")).toThrow(/不能删除/);

    // Kept across a restart (the Host's settings).
    expect(new ClaudeAccounts(store, { defaultDir: mine, defaultExplicit: false, root: join(root, "accounts") }).currentId()).toBe(id);
    await accounts.switchTo("default");
    accounts.rename(id, "公司");
    expect(accounts.homes().map((h) => [h.label, h.current])).toEqual([
      ["本机默认账号", true],
      ["公司", false],
    ]);
    accounts.remove(id);
    expect(existsSync(dir)).toBe(false);
    expect(accounts.count()).toBe(1);
  });
});
