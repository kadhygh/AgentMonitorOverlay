import type { ModelOption, ModelProfile } from "@amo-studio/protocol";
import { GLM_MODELS } from "../choices.js";
import type { CredentialReader } from "../credentials.js";

// Environment for a managed Claude Code process. The routing for GLM follows old AMO's glm-5.3 preset
// (broker/lib/claude-provider.js); see spikes/RESULTS.md section h.

/**
 * An Anthropic-compatible endpoint plus the model mapping the CLI should use with it, or (`auth: "oauth"`) the person's
 * own Claude subscription through a long-lived token from `claude setup-token`.
 */
export interface ClaudeProviderDef {
  /** Absent for the subscription: the CLI talks to Anthropic itself. */
  baseUrl?: string;
  /** "oauth": the profile's credential is a subscription token (CLAUDE_CODE_OAUTH_TOKEN), not an API key. */
  auth?: "oauth";
  /** Models of a non-Anthropic endpoint (Claude Code's own list only knows Claude models). */
  models?: ModelOption[];
  /** Extra variables (model mapping, timeouts). The key never goes here; it comes from the profile's credential. */
  env?: Record<string, string>;
}

export const BUILTIN_CLAUDE_PROVIDERS: Record<string, ClaudeProviderDef> = {
  anthropic: { auth: "oauth" },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    models: GLM_MODELS,
    env: {
      ANTHROPIC_MODEL: "glm-5.3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      API_TIMEOUT_MS: "3000000",
    },
  },
};

export class ClaudeProfileError extends Error {}

/**
 * Inherited variables minus anything Claude/Anthropic (the Host may itself be started from a Claude Code shell), plus
 * the provider routing, the key from the profile's credential, and Studio's own CLAUDE_CONFIG_DIR so nothing is read
 * from or written to the person's ~/.claude.
 */
export function claudeEnv(
  profile: ModelProfile,
  providers: Record<string, ClaudeProviderDef>,
  credentials: CredentialReader,
  claudeHome: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!profile.provider) throw new ClaudeProfileError(`Claude profile ${profile.id} needs a provider: Studio does not use the Claude subscription login`);
  const provider = providers[profile.provider];
  if (!provider) throw new ClaudeProfileError(`unknown Claude provider ${profile.provider}`);
  const key = profile.credentialId ? credentials.read(profile.credentialId) : null;
  if (profile.credentialId && !key) {
    throw new ClaudeProfileError(
      provider.auth === "oauth"
        ? "还没有保存 Claude 订阅令牌：在终端运行 claude setup-token，再到 设置 → 模型凭据 里保存"
        : `profile ${profile.id} needs credential ${profile.credentialId}, which is not stored`,
    );
  }
  const inherited = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k))) as Record<string, string>;
  return {
    ...inherited,
    ...provider.env,
    ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}),
    ...(provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
    ...(key ? (provider.auth === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_AUTH_TOKEN: key }) : {}),
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Without this, commands the agent runs (Bash) inherit ANTHROPIC_AUTH_TOKEN, and `env` prints the key into the
    // transcript (verified in the S4-09 review).
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
  };
}
