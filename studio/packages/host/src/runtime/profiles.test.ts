import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { StaticCredentialReader, WindowsCredentialReader } from "./credentials.js";
import { BUILTIN_PROFILES, CredentialMissingError, codexServerSpec, codexThreadParams } from "./profiles.js";

const SECRET = "sk-test-not-a-real-key";
const creds = new StaticCredentialReader({ "deepseek-v4": SECRET });
const byId = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id)!;

/** Parses `-c key="value"` pairs back into a map. */
function config(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    expect(args[i]).toBe("-c");
    const [key, ...rest] = args[i + 1]!.split("=");
    out[key!] = JSON.parse(rest.join("="));
  }
  return out;
}

describe("codexServerSpec", () => {
  it("makes the DeepSeek profile the server default and passes the key only through env", () => {
    const spec = codexServerSpec(byId("codex-deepseek-flash"), BUILTIN_PROFILES, creds);
    const c = config(spec.configArgs);
    expect(c).toMatchObject({
      model_provider: "amo-deepseek",
      model: "deepseek-flash",
      review_model: "deepseek-flash",
      model_reasoning_effort: "low",
      "model_providers.amo-deepseek.base_url": "https://api.deepseek.com/",
      "model_providers.amo-deepseek.wire_api": "responses",
      "model_providers.amo-deepseek.env_key": "DEEPSEEK_API_KEY",
    });
    expect(c.model_catalog_json).toMatch(/assets\/codex\/deepseek-flash\.models\.json$/);
    expect(spec.env).toEqual({ DEEPSEEK_API_KEY: SECRET });
    expect(spec.configArgs.join(" ")).not.toContain(SECRET);
  });

  it("keeps provider keys and the MCP token out of the agent's command environment", () => {
    const cfg = config(codexServerSpec(byId("codex-deepseek-flash"), BUILTIN_PROFILES, creds).configArgs) as Record<string, unknown>;
    expect(cfg["shell_environment_policy.ignore_default_excludes"]).toBe(false);
    expect(cfg["shell_environment_policy.exclude"]).toEqual(["AMO_STUDIO_MCP_TOKEN", "DEEPSEEK_API_KEY"]);
  });

  it("points every server at the AMO MCP with the token only in the env", () => {
    const spec = codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, creds, { mcp: { url: "http://127.0.0.1:47900/mcp", token: "mcp-secret" } });
    expect(config(spec.configArgs)).toMatchObject({ "mcp_servers.amo.url": "http://127.0.0.1:47900/mcp", "mcp_servers.amo.bearer_token_env_var": "AMO_STUDIO_MCP_TOKEN" });
    expect(spec.configArgs.join(" ")).not.toContain("mcp-secret");
    expect(spec.env.AMO_STUDIO_MCP_TOKEN).toBe("mcp-secret");
    expect(Object.keys(config(codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, creds).configArgs)).some((k) => k.startsWith("mcp_servers."))).toBe(false);
  });

  it("never emits agents.* overrides (rejected by Codex 0.161)", () => {
    for (const profile of BUILTIN_PROFILES.filter((p) => p.runtime === "codex")) {
      expect(Object.keys(config(codexServerSpec(profile, BUILTIN_PROFILES, creds).configArgs)).some((k) => k.startsWith("agents."))).toBe(false);
    }
  });

  it("keeps the user's own default on the Codex profile but still defines other providers", () => {
    const spec = codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, creds);
    const c = config(spec.configArgs);
    expect(c.model_provider).toBeUndefined();
    expect(c.model).toBeUndefined();
    expect(c.model_catalog_json).toBeUndefined();
    expect(c["model_providers.amo-deepseek.env_key"]).toBe("DEEPSEEK_API_KEY");
    expect(spec.env.DEEPSEEK_API_KEY).toBe(SECRET);
  });

  it("fails for a profile whose own key is missing, and only reports other missing keys", () => {
    const empty = new StaticCredentialReader({});
    expect(() => codexServerSpec(byId("codex-deepseek-flash"), BUILTIN_PROFILES, empty)).toThrow(CredentialMissingError);
    const spec = codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, empty);
    expect(spec.missingCredentials).toEqual(["amo-deepseek"]);
    expect(spec.env).toEqual({});
  });

  it("rejects unknown providers and non-Codex profiles", () => {
    const bad: ModelProfile = { id: "x", label: "x", runtime: "codex", provider: "nope", model: "m" };
    expect(() => codexServerSpec(bad, [bad], creds)).toThrow(/unknown Codex provider/);
    const claude: ModelProfile = { id: "c", label: "c", runtime: "claude", provider: "glm", model: "glm" };
    expect(() => codexServerSpec(claude, [claude], creds)).toThrow(/not a Codex profile/);
  });
});

describe("codexThreadParams", () => {
  it("is explicit for routed profiles and empty for the user default", () => {
    expect(codexThreadParams(byId("codex-deepseek-flash"))).toEqual({
      modelProvider: "amo-deepseek",
      model: "deepseek-flash",
      config: { model_reasoning_effort: "low" },
    });
    expect(codexThreadParams(byId("codex-default"))).toEqual({});
  });
});

describe("WindowsCredentialReader", () => {
  it("rejects ids that could break out of the script", () => {
    expect(() => new WindowsCredentialReader().read("x'; whoami; '")).toThrow(/invalid credential id/);
  });
});
