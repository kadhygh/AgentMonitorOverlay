import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { StaticCredentialReader } from "../credentials.js";
import { BUILTIN_CLAUDE_PROVIDERS, ClaudeProfileError, claudeEnv, type ClaudeHome } from "./claude-env.js";
import { bundledClaudeExe } from "./transcripts.js";

const studio = (dir: string): ClaudeHome => ({ dir, login: "token" });

const glm: ModelProfile = { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: null, credentialId: "glm-5.2" };
const credentials = new StaticCredentialReader({ "glm-5.2": "secret-key" });
const base = { PATH: "C:/bin", ANTHROPIC_API_KEY: "leak", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", claude_config_dir: "C:/Users/me/.claude" };

describe("claudeEnv", () => {
  it("routes to the provider with Studio's own config dir and nothing inherited from Claude", () => {
    const env = claudeEnv(glm, BUILTIN_CLAUDE_PROVIDERS, credentials, studio("D:/studio/.data/claude-home"), base);
    expect(env).toMatchObject({
      PATH: "C:/bin",
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "secret-key",
      ANTHROPIC_MODEL: "glm-5.3[1m]",
      CLAUDE_CONFIG_DIR: "D:/studio/.data/claude-home",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_BASH_EDIT_DIFF: "0",
      CLAUDE_CODE_AUTO_MODE_GIT_STATUS: "0",
      CLAUDE_CODE_AUTO_MODE_GIT_STATUS_UPLOADS: "0",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.claude_config_dir).toBeUndefined();
  });

  // 2026-10-21: the switch that stops auto mode's whole-checkout git snapshots lives in the CLI. A new SDK that drops or
  // renames it would bring the desktop-wide lag back without a word, so the bundled CLI must still know the name.
  // 2026-10-27: and the ones that stop auto mode's own git status scans.
  it("the bundled CLI still knows CLAUDE_CODE_BASH_EDIT_DIFF and the auto mode git status switches", async () => {
    const names = ["CLAUDE_CODE_BASH_EDIT_DIFF", "CLAUDE_CODE_AUTO_MODE_GIT_STATUS", "CLAUDE_CODE_AUTO_MODE_GIT_STATUS_UPLOADS"];
    const wants = names.map((n) => Buffer.from(n));
    const longest = Math.max(...wants.map((w) => w.length));
    const found = new Set<string>();
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(bundledClaudeExe()) as AsyncIterable<Buffer>) {
      const both = Buffer.concat([tail, chunk]);
      wants.forEach((w, i) => both.includes(w) && found.add(names[i]!));
      if (found.size === names.length) break;
      tail = both.subarray(both.length - longest);
    }
    expect([...found].sort()).toEqual([...names].sort());
  });

  it("lets the profile pick the model", () => {
    expect(claudeEnv({ ...glm, model: "glm-4.7" }, BUILTIN_CLAUDE_PROVIDERS, credentials, studio("home"), base).ANTHROPIC_MODEL).toBe("glm-4.7");
  });

  it("refuses a profile without a provider (the subscription login) or without its stored key", () => {
    expect(() => claudeEnv({ ...glm, provider: null }, BUILTIN_CLAUDE_PROVIDERS, credentials, studio("home"), base)).toThrow(ClaudeProfileError);
    expect(() => claudeEnv({ ...glm, provider: "nope" }, BUILTIN_CLAUDE_PROVIDERS, credentials, studio("home"), base)).toThrow(/unknown Claude provider/);
    expect(() => claudeEnv(glm, BUILTIN_CLAUDE_PROVIDERS, new StaticCredentialReader({}), studio("home"), base)).toThrow(/not stored/);
  });

  it("uses the subscription token for the Claude subscription, with no endpoint override", () => {
    const sub: ModelProfile = { id: "claude-subscription", label: "Claude 订阅", runtime: "claude", provider: "anthropic", model: null, credentialId: "claude-subscription" };
    const env = claudeEnv(sub, BUILTIN_CLAUDE_PROVIDERS, new StaticCredentialReader({ "claude-subscription": "sk-ant-oat-x" }), studio("home"), base);
    expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", CLAUDE_CONFIG_DIR: "home", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(() => claudeEnv(sub, BUILTIN_CLAUDE_PROVIDERS, new StaticCredentialReader({}), studio("home"), base)).toThrow(/claude setup-token/);
  });

  it("signs the subscription in from the person's own Claude Code with the local login: no token, their config dir", () => {
    const sub: ModelProfile = { id: "claude-subscription", label: "Claude", runtime: "claude", provider: "anthropic", model: null, credentialId: "claude-subscription" };
    const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-local-"));
    try {
      writeFileSync(join(dir, ".credentials.json"), "{}");
      const token = new StaticCredentialReader({ "claude-subscription": "sk-ant-oat-x" });
      // Their ~/.claude: CLAUDE_CONFIG_DIR stays unset, so the CLI also finds ~/.claude.json as in a terminal.
      const env = claudeEnv(sub, BUILTIN_CLAUDE_PROVIDERS, token, { dir, login: "local" }, base);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
      // A dir they set themselves is passed on; no saved token is needed either way.
      expect(claudeEnv(sub, BUILTIN_CLAUDE_PROVIDERS, new StaticCredentialReader({}), { dir, login: "local", explicit: true }, base).CLAUDE_CONFIG_DIR).toBe(dir);
      // Other providers never take the local login.
      expect(claudeEnv(glm, BUILTIN_CLAUDE_PROVIDERS, credentials, { dir, login: "local" }, base)).toMatchObject({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_AUTH_TOKEN: "secret-key" });
      if (process.platform === "win32") {
        rmSync(join(dir, ".credentials.json"));
        expect(() => claudeEnv(sub, BUILTIN_CLAUDE_PROVIDERS, token, { dir, login: "local" }, base)).toThrow(/没找到本机 Claude Code 的登录/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
