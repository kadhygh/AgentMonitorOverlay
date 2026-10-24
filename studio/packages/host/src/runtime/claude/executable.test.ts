import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeStatus, ModelProfile, StateSnapshot } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../credentials.js";
import { findClaudeCode, olderVersion, sdkClaudeCodeVersion } from "./executable.js";

const roots: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.shutdown();
  for (const r of roots.splice(0)) removeTempDir(r);
  delete process.env.AMO_STUDIO_CLAUDE;
});
const tempRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "amo-claude-exe-"));
  roots.push(r);
  return r;
};
const touch = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
};

describe("which Claude Code the Claude sessions run on (2026-10-24)", () => {
  it("takes AMO_STUDIO_CLAUDE, then the SDK's copy, then the person's install, else none", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const sdk = touch(join(root, "sdk", "claude.exe"));
    const own = touch(join(root, "bin", "claude.exe"));
    const env = { PATH: join(root, "bin"), USERPROFILE: home };
    expect(findClaudeCode({ ...env, AMO_STUDIO_CLAUDE: sdk }, null)).toEqual({ path: sdk, source: "env" });
    // One that does not exist is none at all, whatever else there is.
    expect(findClaudeCode({ ...env, AMO_STUDIO_CLAUDE: join(root, "gone.exe") }, sdk)).toBeNull();
    expect(findClaudeCode(env, sdk)).toEqual({ path: sdk, source: "bundled" });
    // The portable build: no SDK copy.
    expect(findClaudeCode(env, null)).toEqual({ path: own, source: "installed" });
    expect(findClaudeCode({ PATH: "", USERPROFILE: home }, null)).toBeNull();
    // The native installer's place, though Studio's PATH predates it.
    const native = touch(join(home, ".local", "bin", "claude.exe"));
    expect(findClaudeCode({ PATH: "", USERPROFILE: home }, null)).toEqual({ path: native, source: "installed" });
  });

  it("starts npm's install through the exe its claude.cmd wraps", () => {
    const root = tempRoot();
    const npm = join(root, "npm");
    touch(join(npm, "claude.cmd"));
    const env = { PATH: npm, USERPROFILE: join(root, "home") };
    // Only the .cmd, no exe behind it: not something Studio can start.
    expect(findClaudeCode(env, null)).toBeNull();
    const exe = touch(join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    expect(findClaudeCode(env, null)).toEqual({ path: exe, source: "installed" });
    expect(findClaudeCode({ PATH: "", APPDATA: root, USERPROFILE: join(root, "home") }, null)).toEqual({ path: exe, source: "installed" });
  });

  it("compares versions with the SDK's", () => {
    expect(sdkClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(olderVersion("2.1.299", "2.1.304")).toBe(true);
    expect(olderVersion("2.1.309", "2.1.304")).toBe(false);
    expect(olderVersion("2.1.304", "2.1.304")).toBe(false);
    expect(olderVersion("2.0.999", "2.1.0")).toBe(true);
  });

  it("without one, every channel on Claude Code is unavailable, and 重新检测 brings them back", async () => {
    const root = tempRoot();
    const PROFILES: ModelProfile[] = [
      { id: "claude-subscription", label: "Claude", runtime: "claude", provider: null, model: null, credentialId: "claude-subscription" },
      { id: "codex-default", label: "Codex", runtime: "codex", provider: null, model: null },
    ];
    process.env.AMO_STUDIO_CLAUDE = join(root, "no-claude.exe");
    const host = await startHost({ dataDir: join(root, "data"), port: 0, profiles: PROFILES, servers: new FakeServers([]), credentials: new StaticCredentialReader({}) });
    running.push(host);
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${host.info.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return (await res.json()) as T;
    };
    const unavailable = async () => Object.fromEntries((await call<StateSnapshot>("GET", "/api/state")).profiles.map((p) => [p.id, p.unavailable ?? null]));
    await call("POST", "/api/channels", { kind: "claude", label: "中转", baseUrl: "https://relay.example/anthropic", model: "m1", key: "sk-relay" });
    const custom = (await call<StateSnapshot>("GET", "/api/state")).profiles.find((p) => p.custom)!;
    expect(await unavailable()).toEqual({ "claude-subscription": expect.stringMatching(/没有找到 Claude Code/), "codex-default": null, [custom.id]: expect.stringMatching(/没有找到 Claude Code/) });
    expect(await call<ClaudeCodeStatus>("GET", "/api/claude-code")).toMatchObject({ path: null, source: null, version: null });

    // Installed since: found on 重新检测, without a restart.
    process.env.AMO_STUDIO_CLAUDE = touch(join(root, "claude.exe"));
    const status = await call<ClaudeCodeStatus>("POST", "/api/claude-code/check");
    expect(status).toMatchObject({ path: process.env.AMO_STUDIO_CLAUDE, source: "env" });
    expect(await unavailable()).toEqual({ "claude-subscription": null, "codex-default": null, [custom.id]: null });
  });
});
