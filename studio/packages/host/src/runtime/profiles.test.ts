import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { StaticCredentialReader, WindowsCredentialReader } from "./credentials.js";
import { BUILTIN_PROFILES, CredentialMissingError, codexServerSpec, codexThreadParams, type CodexProviderDef } from "./profiles.js";

// A routed Codex profile of the kind a third-party Codex channel makes (the built-in DeepSeek on Codex is gone since
// 2026-11-03), with a model catalog to check that it is applied only on its own server.
const SECRET = "sk-test-not-a-real-key";
const creds = new StaticCredentialReader({ relay: SECRET });
const PROVIDERS: Record<string, CodexProviderDef> = {
  "amo-relay": { name: "Relay", baseUrl: "https://relay.example/", wireApi: "responses", envKey: "RELAY_API_KEY", catalog: "relay.models.json" },
};
const RELAY: ModelProfile = { id: "codex-relay", label: "Relay", runtime: "codex", provider: "amo-relay", model: "relay-flash", reasoningEffort: "low", credentialId: "relay" };
const PROFILES = [...BUILTIN_PROFILES, RELAY];
const OPTS = { providers: PROVIDERS, assetsDir: "/amo/assets/codex" };
const byId = (id: string) => PROFILES.find((p) => p.id === id)!;

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
  it("has no built-in routed Codex profile any more (DeepSeek runs on DSH)", () => {
    expect(BUILTIN_PROFILES.filter((p) => p.runtime === "codex").map((p) => p.id)).toEqual(["codex-default"]);
  });

  it("makes a routed profile the server default and passes the key only through env", () => {
    const spec = codexServerSpec(RELAY, PROFILES, creds, OPTS);
    const c = config(spec.configArgs);
    expect(c).toMatchObject({
      model_provider: "amo-relay",
      model: "relay-flash",
      review_model: "relay-flash",
      model_reasoning_effort: "low",
      "model_providers.amo-relay.base_url": "https://relay.example/",
      "model_providers.amo-relay.wire_api": "responses",
      "model_providers.amo-relay.env_key": "RELAY_API_KEY",
    });
    expect(c.model_catalog_json).toBe("/amo/assets/codex/relay.models.json");
    expect(spec.env).toEqual({ RELAY_API_KEY: SECRET });
    expect(spec.configArgs.join(" ")).not.toContain(SECRET);
  });

  it("keeps provider keys and the MCP token out of the agent's command environment", () => {
    const cfg = config(codexServerSpec(RELAY, PROFILES, creds, OPTS).configArgs) as Record<string, unknown>;
    expect(cfg["shell_environment_policy.ignore_default_excludes"]).toBe(false);
    expect(cfg["shell_environment_policy.exclude"]).toEqual(["AMO_STUDIO_MCP_TOKEN", "RELAY_API_KEY"]);
  });

  it("points every server at the AMO MCP with the token only in the env", () => {
    const spec = codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, creds, { mcp: { url: "http://127.0.0.1:47900/mcp", token: "mcp-secret" } });
    expect(config(spec.configArgs)).toMatchObject({ "mcp_servers.amo.url": "http://127.0.0.1:47900/mcp", "mcp_servers.amo.bearer_token_env_var": "AMO_STUDIO_MCP_TOKEN" });
    expect(spec.configArgs.join(" ")).not.toContain("mcp-secret");
    expect(spec.env.AMO_STUDIO_MCP_TOKEN).toBe("mcp-secret");
    // Writes to the caller's own task run without asking; other writes ask through an MCP elicitation.
    expect(config(spec.configArgs)).toMatchObject({
      "mcp_servers.amo.tools.task_note_add.approval_mode": "approve",
      "mcp_servers.amo.tools.handoff_submit.approval_mode": "approve",
      "mcp_servers.amo.tools.checklist_check.approval_mode": "approve",
      "mcp_servers.amo.tools.schedule_propose.approval_mode": "approve",
      "mcp_servers.amo.tools.canvas_group_create.approval_mode": "prompt",
      "mcp_servers.amo.tools.canvas_place.approval_mode": "prompt",
    });
    expect(Object.keys(config(codexServerSpec(byId("codex-default"), BUILTIN_PROFILES, creds).configArgs)).some((k) => k.startsWith("mcp_servers."))).toBe(false);
  });

  it("never emits agents.* overrides (rejected by Codex 0.161)", () => {
    for (const profile of PROFILES.filter((p) => p.runtime === "codex")) {
      expect(Object.keys(config(codexServerSpec(profile, PROFILES, creds, OPTS).configArgs)).some((k) => k.startsWith("agents."))).toBe(false);
    }
  });

  it("keeps the user's own default on the Codex profile but still defines other providers", () => {
    const spec = codexServerSpec(byId("codex-default"), PROFILES, creds, OPTS);
    const c = config(spec.configArgs);
    expect(c.model_provider).toBeUndefined();
    expect(c.model).toBeUndefined();
    expect(c.model_catalog_json).toBeUndefined();
    expect(c["model_providers.amo-relay.env_key"]).toBe("RELAY_API_KEY");
    expect(spec.env.RELAY_API_KEY).toBe(SECRET);
  });

  it("fails for a profile whose own key is missing, and only reports other missing keys", () => {
    const empty = new StaticCredentialReader({});
    expect(() => codexServerSpec(RELAY, PROFILES, empty, OPTS)).toThrow(CredentialMissingError);
    const spec = codexServerSpec(byId("codex-default"), PROFILES, empty, OPTS);
    expect(spec.missingCredentials).toEqual(["amo-relay"]);
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
    expect(codexThreadParams(RELAY)).toEqual({
      modelProvider: "amo-relay",
      model: "relay-flash",
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
