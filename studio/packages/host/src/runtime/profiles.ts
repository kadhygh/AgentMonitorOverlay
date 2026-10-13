import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProfile } from "@amo-studio/protocol";
import type { CredentialReader } from "./credentials.js";
import { AUTO_APPROVED_WRITE_TOOLS, PROMPTED_WRITE_TOOLS } from "../mcp/names.js";

// Model profiles and how they turn into `codex app-server` launch options. Rules from studio/spikes/RESULTS.md:
// - provider definitions must be passed at server launch (per-thread definitions do not survive a restart);
// - forks, side chats and subagents fall back to the server default provider, so each profile gets its own server
//   whose default is that profile;
// - Codex 0.161 rejects `agents.default_subagent_*`, so it is never emitted.

export interface CodexProviderDef {
  name: string;
  baseUrl: string;
  wireApi: "responses";
  /** Env var the key is passed through. */
  envKey: string;
  /** Model catalog file (absolute, or relative to packages/host/assets/codex), applied only on servers whose default is this provider. */
  catalog?: string;
}

export const CODEX_PROVIDERS: Record<string, CodexProviderDef> = {
  "amo-deepseek": {
    name: "DeepSeek Flash",
    baseUrl: "https://api.deepseek.com/",
    wireApi: "responses",
    envKey: "DEEPSEEK_API_KEY",
    catalog: "deepseek-flash.models.json",
  },
};

/** Env var that carries the MCP-only token to Codex app-servers. */
export const AMO_MCP_TOKEN_ENV = "AMO_STUDIO_MCP_TOKEN";

/** Credential Manager entry for the Claude subscription token, the only one Studio itself writes (设置 → 模型凭据). */
export const CLAUDE_SUBSCRIPTION_CREDENTIAL = "claude-subscription";

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  // The person's own Codex login and default model (a ChatGPT subscription: GPT).
  { id: "codex-default", label: "GPT", runtime: "codex", provider: null, model: null },
  {
    id: "codex-deepseek-flash",
    label: "DeepSeek",
    runtime: "codex",
    provider: "amo-deepseek",
    model: "deepseek-flash",
    reasoningEffort: "low",
    credentialId: "deepseek-v4",
  },
  // Claude Code routed to GLM (old AMO's glm-5.3 preset; the key is the Coding Plan key stored as glm-5.2).
  { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: "glm-5.3[1m]", credentialId: "glm-5.2" },
  // The person's Claude subscription, through a token from `claude setup-token` saved in 设置 → 模型凭据.
  { id: "claude-subscription", label: "Claude", runtime: "claude", provider: "anthropic", model: null, credentialId: CLAUDE_SUBSCRIPTION_CREDENTIAL },
];

// src/ and dist/ sit at the same depth under packages/host.
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "codex");

export interface CodexServerSpec {
  profileId: string;
  /** `-c key=value` pairs for `codex app-server`. Contains no secrets. */
  configArgs: string[];
  /** Extra env for the server process: API keys and, in tests, CODEX_HOME. */
  env: Record<string, string>;
  /** Providers whose key was missing; their threads will fail to authenticate. */
  missingCredentials: string[];
}

export class CredentialMissingError extends Error {
  constructor(readonly profileId: string, readonly credentialId: string) {
    super(`profile ${profileId} needs credential ${credentialId}, which is not stored`);
    this.name = "CredentialMissingError";
  }
}

const tomlString = (value: string) => JSON.stringify(value);
const configArg = (key: string, value: string) => ["-c", `${key}=${tomlString(value)}`];

/**
 * Launch options for the app-server that serves `profile`. Every known provider is defined so threads of other
 * profiles can still be resumed there; the profile itself becomes the server default.
 */
export function codexServerSpec(
  profile: ModelProfile,
  profiles: readonly ModelProfile[],
  credentials: CredentialReader,
  options: { providers?: Record<string, CodexProviderDef>; assetsDir?: string; mcp?: { url: string; token: string } | null } = {},
): CodexServerSpec {
  if (profile.runtime !== "codex") throw new Error(`profile ${profile.id} is not a Codex profile`);
  const providers = options.providers ?? CODEX_PROVIDERS;
  const assetsDir = options.assetsDir ?? ASSETS_DIR;
  // The model's raw thinking (DeepSeek-style reasoning content) is shown in the conversation, as in DSH.
  const configArgs: string[] = ["-c", "show_raw_agent_reasoning=true"];
  const env: Record<string, string> = {};
  const missingCredentials: string[] = [];

  const used = new Set(profiles.filter((p) => p.runtime === "codex" && p.provider).map((p) => p.provider!));
  if (profile.provider) used.add(profile.provider);
  for (const id of [...used].sort()) {
    const def = providers[id];
    if (!def) throw new Error(`unknown Codex provider ${id}`);
    configArgs.push(
      ...configArg(`model_providers.${id}.name`, def.name),
      ...configArg(`model_providers.${id}.base_url`, def.baseUrl),
      ...configArg(`model_providers.${id}.wire_api`, def.wireApi),
      ...configArg(`model_providers.${id}.env_key`, def.envKey),
    );
    const credentialId = profiles.find((p) => p.provider === id && p.credentialId)?.credentialId ?? (profile.provider === id ? profile.credentialId : undefined);
    if (!credentialId) continue;
    const secret = credentials.read(credentialId);
    if (secret) env[def.envKey] = secret;
    else if (profile.provider === id) throw new CredentialMissingError(profile.id, credentialId);
    else missingCredentials.push(id);
  }

  if (profile.provider) {
    const def = providers[profile.provider]!;
    configArgs.push(...configArg("model_provider", profile.provider));
    if (def.catalog) configArgs.push(...configArg("model_catalog_json", (isAbsolute(def.catalog) ? def.catalog : join(assetsDir, def.catalog)).replaceAll("\\", "/")));
  }
  if (profile.model) configArgs.push(...configArg("model", profile.model), ...configArg("review_model", profile.model));
  if (profile.reasoningEffort) configArgs.push(...configArg("model_reasoning_effort", profile.reasoningEffort));

  // The AMO MCP (read-only) for every thread on this server. The token travels in the env, never on the command line.
  if (options.mcp) {
    configArgs.push(...configArg("mcp_servers.amo.url", options.mcp.url), ...configArg("mcp_servers.amo.bearer_token_env_var", AMO_MCP_TOKEN_ENV));
    // Writes to the caller's own task run without asking; any other non-read-only tool asks (mcpServer/elicitation).
    for (const name of AUTO_APPROVED_WRITE_TOOLS) configArgs.push(...configArg(`mcp_servers.amo.tools.${name}.approval_mode`, "approve"));
    for (const name of PROMPTED_WRITE_TOOLS) configArgs.push(...configArg(`mcp_servers.amo.tools.${name}.approval_mode`, "prompt"));
    env[AMO_MCP_TOKEN_ENV] = options.mcp.token;
  }

  // Commands the agent runs inherit the server's environment; Codex 0.161 passed the provider keys and the MCP token
  // straight through (S4-09 review). Keep its default KEY/SECRET/TOKEN filter on and name ours explicitly.
  const secrets = [...new Set([...[...used].map((id) => providers[id]!.envKey), AMO_MCP_TOKEN_ENV])].sort();
  configArgs.push("-c", "shell_environment_policy.ignore_default_excludes=false", "-c", `shell_environment_policy.exclude=[${secrets.map(tomlString).join(",")}]`);

  return { profileId: profile.id, configArgs, env, missingCredentials };
}

/** Explicit provider and model for thread/start and thread/fork, so a fork never silently changes provider. */
export function codexThreadParams(profile: ModelProfile): { modelProvider?: string; model?: string; config?: Record<string, unknown> } {
  const out: { modelProvider?: string; model?: string; config?: Record<string, unknown> } = {};
  if (profile.provider) out.modelProvider = profile.provider;
  if (profile.model) out.model = profile.model;
  if (profile.reasoningEffort) out.config = { model_reasoning_effort: profile.reasoningEffort };
  return out;
}
