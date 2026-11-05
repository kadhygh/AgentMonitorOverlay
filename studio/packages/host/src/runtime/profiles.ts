import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BalanceConfig, codex, McpServerSpec, ModelProfile } from "@amo-studio/protocol";
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

/**
 * Built-in Codex providers: none since 2026-11-03 (the user retired DeepSeek on Codex; DeepSeek runs on DSH). The
 * person's third-party Codex channels add theirs (channels.ts).
 */
export const CODEX_PROVIDERS: Record<string, CodexProviderDef> = {};

/** Env var that carries the MCP-only token to Codex app-servers. */
export const AMO_MCP_TOKEN_ENV = "AMO_STUDIO_MCP_TOKEN";

/** Credential Manager entry for the Claude subscription token, the only one Studio itself writes (设置 → 模型凭据). */
export const CLAUDE_SUBSCRIPTION_CREDENTIAL = "claude-subscription";

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  // The person's own Codex login and default model (a ChatGPT subscription: GPT).
  { id: "codex-default", label: "GPT", runtime: "codex", provider: null, model: null },
  // Claude Code routed to GLM (old AMO's glm-5.3 preset; the key is the Coding Plan key stored as glm-5.2).
  { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: "glm-5.3[1m]", credentialId: "glm-5.2" },
  // The person's Claude subscription, on their own Claude Code login (no token since 2026-10-27).
  { id: "claude-subscription", label: "Claude", runtime: "claude", provider: "anthropic", model: null },
  // DeepSeek on DSH's own harness (stage 17): the DSH desktop app or a source clone (设置 → 模型). It signs in with the
  // DeepSeek account of the desktop app or with this key (2026-11-03, dsh/install.ts DSH_AUTH_KEY). Sessions of the
  // retired `codex-deepseek-flash` (DeepSeek on Codex, removed 2026-11-03) stay readable but cannot go on.
  { id: "dsh-deepseek", label: "DeepSeek", runtime: "dsh", provider: "deepseek-official", model: null, credentialId: "deepseek-v4" },
];

/** Built-in profiles whose site tells the balance (设置 → 模型, 左下角额度). */
export const BUILTIN_BALANCES: Record<string, { baseUrl: string; config: BalanceConfig }> = {
  "dsh-deepseek": { baseUrl: "https://api.deepseek.com", config: { template: "deepseek" } },
};

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

/**
 * A session's profile is not there any more (a removed channel, or the retired `codex-deepseek-flash`, 2026-11-03): its
 * conversation stays readable, a new message says why it cannot go on.
 */
export function profileGone(profileId: string): Error {
  return Object.assign(new Error(`这个会话用的模型渠道已经没有了（${profileId}），不能接着发消息：新开一个会话接着做`), { code: "bad_request" });
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
  options: {
    providers?: Record<string, CodexProviderDef>;
    assetsDir?: string;
    mcp?: { url: string; token: string } | null;
    /** MCP 设置 (2026-11-04): Studio's own servers that are on, for every thread of this server. */
    extraMcp?: Record<string, McpServerSpec>;
    /** The environment the server starts from (default: process.env): an env value of an MCP that one already has goes inline. */
    baseEnv?: NodeJS.ProcessEnv;
  } = {},
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

  // Studio's MCP servers (设置 → MCP). Their secrets travel in the server's env like the AMO token: a stdio server's env
  // through env_vars (a name the server already has, PATH say, goes inline instead: it is not one of Studio's secrets
  // and must not change for the server), a remote one's headers through env_http_headers. Codex has no SSE transport.
  const mcpSecrets: string[] = [];
  const base = options.baseEnv ?? process.env;
  let h = 0;
  for (const [name, spec] of Object.entries(options.extraMcp ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name === "amo") continue;
    const key = `mcp_servers.${name}`;
    if (spec.type === "stdio" && spec.command) {
      configArgs.push(...configArg(`${key}.command`, spec.command));
      if (spec.args?.length) configArgs.push("-c", `${key}.args=[${spec.args.map(tomlString).join(",")}]`);
      const forward: string[] = [];
      for (const [k, v] of Object.entries(spec.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (base[k] !== undefined) configArgs.push(...configArg(`${key}.env.${k}`, v));
        else {
          env[k] = v;
          forward.push(k);
          mcpSecrets.push(k);
        }
      }
      if (forward.length) configArgs.push("-c", `${key}.env_vars=[${forward.map(tomlString).join(",")}]`);
    } else if (spec.type === "http" && spec.url) {
      configArgs.push(...configArg(`${key}.url`, spec.url));
      const headers = Object.entries(spec.headers ?? {});
      if (headers.length) {
        const pairs = headers.map(([header, value]) => {
          const envName = `AMO_STUDIO_MCP_H${h++}`;
          env[envName] = value;
          mcpSecrets.push(envName);
          return `${tomlString(header)}=${tomlString(envName)}`;
        });
        configArgs.push("-c", `${key}.env_http_headers={${pairs.join(",")}}`);
      }
    }
  }

  // Commands the agent runs inherit the server's environment; Codex 0.161 passed the provider keys and the MCP token
  // straight through (S4-09 review). Keep its default KEY/SECRET/TOKEN filter on and name ours explicitly.
  const secrets = [...new Set([...[...used].map((id) => providers[id]!.envKey), AMO_MCP_TOKEN_ENV, ...mcpSecrets])].sort();
  configArgs.push("-c", "shell_environment_policy.ignore_default_excludes=false", "-c", `shell_environment_policy.exclude=[${secrets.map(tomlString).join(",")}]`);

  return { profileId: profile.id, configArgs, env, missingCredentials };
}

/** A thread's `config` (thread/start, fork, resume): Codex config keys with JSON values. */
export type CodexConfig = NonNullable<codex.v2.ThreadStartParams["config"]>;

/** Explicit provider and model for thread/start and thread/fork, so a fork never silently changes provider. */
export function codexThreadParams(profile: ModelProfile): { modelProvider?: string; model?: string; config?: CodexConfig } {
  const out: { modelProvider?: string; model?: string; config?: CodexConfig } = {};
  if (profile.provider) out.modelProvider = profile.provider;
  if (profile.model) out.model = profile.model;
  if (profile.reasoningEffort) out.config = { model_reasoning_effort: profile.reasoningEffort };
  return out;
}
