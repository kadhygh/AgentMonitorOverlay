import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { StaticCredentialReader } from "../credentials.js";
import { BUILTIN_CLAUDE_PROVIDERS, ClaudeProfileError, claudeEnv } from "./claude-env.js";

const glm: ModelProfile = { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: null, credentialId: "glm-5.2" };
const credentials = new StaticCredentialReader({ "glm-5.2": "secret-key" });
const base = { PATH: "C:/bin", ANTHROPIC_API_KEY: "leak", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", claude_config_dir: "C:/Users/me/.claude" };

describe("claudeEnv", () => {
  it("routes to the provider with Studio's own config dir and nothing inherited from Claude", () => {
    const env = claudeEnv(glm, BUILTIN_CLAUDE_PROVIDERS, credentials, "D:/studio/.data/claude-home", base);
    expect(env).toMatchObject({
      PATH: "C:/bin",
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "secret-key",
      ANTHROPIC_MODEL: "glm-5.3[1m]",
      CLAUDE_CONFIG_DIR: "D:/studio/.data/claude-home",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.claude_config_dir).toBeUndefined();
  });

  it("lets the profile pick the model", () => {
    expect(claudeEnv({ ...glm, model: "glm-4.7" }, BUILTIN_CLAUDE_PROVIDERS, credentials, "home", base).ANTHROPIC_MODEL).toBe("glm-4.7");
  });

  it("refuses a profile without a provider (the subscription login) or without its stored key", () => {
    expect(() => claudeEnv({ ...glm, provider: null }, BUILTIN_CLAUDE_PROVIDERS, credentials, "home", base)).toThrow(ClaudeProfileError);
    expect(() => claudeEnv({ ...glm, provider: "nope" }, BUILTIN_CLAUDE_PROVIDERS, credentials, "home", base)).toThrow(/unknown Claude provider/);
    expect(() => claudeEnv(glm, BUILTIN_CLAUDE_PROVIDERS, new StaticCredentialReader({}), "home", base)).toThrow(/not stored/);
  });
});
