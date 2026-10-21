import type { ClaudeLogin, ModelOption, ModelProfile } from "@amo-studio/protocol";
import { GLM_MODELS } from "../choices.js";
import type { CredentialReader } from "../credentials.js";
import { localClaudeSignedIn } from "./claude-login.js";

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
  /** Where an API key goes: ANTHROPIC_AUTH_TOKEN (Bearer, the default) or ANTHROPIC_API_KEY (x-api-key). */
  keyEnv?: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
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
 * The config dir a Claude process runs with. "token": Studio's own dir. "local" (only for a subscription provider): the
 * person's Claude Code dir and its login; `explicit` when they set CLAUDE_CONFIG_DIR themselves (otherwise the variable
 * stays unset, so the CLI finds ~/.claude and ~/.claude.json exactly as in a terminal).
 */
export interface ClaudeHome {
  dir: string;
  login: ClaudeLogin;
  explicit?: boolean;
}

/**
 * Inherited variables minus anything Claude/Anthropic (the Host may itself be started from a Claude Code shell), plus
 * the provider routing, the key from the profile's credential, and Studio's own CLAUDE_CONFIG_DIR so nothing is read
 * from or written to the person's ~/.claude. With the local login (the person's choice) there is no key: the CLI signs
 * in from its own config dir.
 */
export function claudeEnv(
  profile: ModelProfile,
  providers: Record<string, ClaudeProviderDef>,
  credentials: CredentialReader,
  home: ClaudeHome,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!profile.provider) throw new ClaudeProfileError(`Claude profile ${profile.id} needs a provider: Studio does not use the Claude subscription login`);
  const provider = providers[profile.provider];
  if (!provider) throw new ClaudeProfileError(`unknown Claude provider ${profile.provider}`);
  const local = home.login === "local" && provider.auth === "oauth";
  if (local && localClaudeSignedIn(home.dir) === false) {
    throw new ClaudeProfileError(`没找到本机 Claude Code 的登录（${home.dir}）：在终端运行 claude 登录一次，或到 设置 → 模型 改用令牌`);
  }
  const key = profile.credentialId && !local ? credentials.read(profile.credentialId) : null;
  if (profile.credentialId && !local && !key) {
    throw new ClaudeProfileError(
      provider.auth === "oauth"
        ? "还没有保存 Claude 订阅令牌：在终端运行 claude setup-token，再到 设置 → 模型 里保存（或在那里改用本机 Claude Code 的登录）"
        : `profile ${profile.id} needs credential ${profile.credentialId}, which is not stored`,
    );
  }
  const inherited = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k))) as Record<string, string>;
  return {
    ...inherited,
    ...provider.env,
    ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}),
    ...(provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
    ...(key ? (provider.auth === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { [provider.keyEnv ?? "ANTHROPIC_AUTH_TOKEN"]: key }) : {}),
    ...(!local || home.explicit ? { CLAUDE_CONFIG_DIR: home.dir } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Without this, commands the agent runs (Bash) inherit ANTHROPIC_AUTH_TOKEN, and `env` prints the key into the
    // transcript (verified in the S4-09 review).
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    // In auto mode the CLI (2.1.304) snapshots the whole checkout with git before and after every Bash command, with the
    // repo's fsmonitor turned off, to show what the command changed. In a 52k-file Unity repo that is a ~1 s scan at
    // 70% of every core, mostly kernel time, every few seconds: the whole desktop lagged, Studio's windows, the mouse
    // and the IME with it (2026-10-21). Studio does not show that diff.
    CLAUDE_CODE_BASH_EDIT_DIFF: "0",
  };
}
