import { invoke } from "@tauri-apps/api/core";
import deepseekManifest from "../../../broker/assets/deepseek/profiles.json";

export type DeepSeekProfilePresetId = `deepseek-profile-${string}`;
export type ClaudeProviderPresetId = "anthropic-default" | "deepseek-v4-pro" | "deepseek-v4" | "glm-5.3" | DeepSeekProfilePresetId;
export type CodexProviderPresetId = "openai-default" | "deepseek-v4-pro" | "deepseek-v4" | "dxx" | "dxx-gpt-6-astra" | DeepSeekProfilePresetId;
export type GrokProviderPresetId = "grok-default";
export type StoredModelProviderId = "deepseek-v4" | "glm-coding" | "dxx";
export type StoredClaudeProviderPresetId = StoredModelProviderId;

export interface ClaudeProviderLaunchConfig {
  presetId: ClaudeProviderPresetId;
  apiKey?: string;
}

export interface CodexProviderLaunchConfig {
  presetId: CodexProviderPresetId;
  apiKey?: string;
}

export interface ClaudeProviderDefinition {
  hidden?: boolean;
  optionLabel?: string;
  id: ClaudeProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
}

export interface CodexProviderDefinition {
  hidden?: boolean;
  optionLabel?: string;
  id: CodexProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
}

export interface GrokProviderDefinition {
  hidden?: boolean;
  optionLabel?: string;
  id: GrokProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
}

export interface StoredModelProviderDefinition {
  id: StoredModelProviderId;
  title: string;
  detail: string;
  model: string;
  keyLabel: string;
}

export interface ModelCredentialStatus {
  ok: boolean;
  configuredProviderIds: string[];
  message: string;
}

export interface ModelCredentialResult {
  ok: boolean;
  providerId: string;
  configured: boolean;
  apiKey?: string;
  message: string;
}

const DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY = "amo.models.defaultClaudeProvider";
const DEFAULT_CODEX_PROVIDER_STORAGE_KEY = "amo.models.defaultCodexProvider";
const CODEX_ASTRA_DEFAULT_MIGRATION_KEY = "amo.models.astraDefaultApplied";
export const DEEPSEEK_DEFAULT_PRESET_ID = deepseekManifest.defaultPresetId as DeepSeekProfilePresetId;
const deepseekPresetIds = new Set(deepseekManifest.profiles.map(profile => profile.id));
const activeDeepseekProfiles = deepseekManifest.profiles
  .filter(profile => profile.releaseId === deepseekManifest.activeRelease)
  .sort((left, right) => Number(right.id === DEEPSEEK_DEFAULT_PRESET_ID) - Number(left.id === DEEPSEEK_DEFAULT_PRESET_ID));

function currentDeepseekDefault(value: string | null) {
  if (value === "deepseek-v4" || value === "deepseek-v4-pro" || (value && deepseekPresetIds.has(value) && !activeDeepseekProfiles.some(profile => profile.id === value))) {
    return DEEPSEEK_DEFAULT_PRESET_ID;
  }
  return value;
}

export const CLAUDE_PROVIDER_DEFINITIONS: ClaudeProviderDefinition[] = [
  {
    id: "anthropic-default",
    title: "Claude default",
    detail: "Use the existing local Claude Code account and configuration.",
    model: "Local Claude configuration",
  },
  {
    id: "deepseek-v4-pro",
    hidden: true,
    title: "DeepSeek V4 Pro",
    detail: "Official Claude Code mapping: V4 Pro for main, Opus, and Sonnet; V4 Flash for Haiku and subagents.",
    model: "deepseek-v4-pro[1m]",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "deepseek-v4",
    hidden: true,
    title: "DeepSeek V4 Flash",
    detail: "Official Anthropic-compatible routing, with V4 Flash for main tasks and subagents.",
    model: "deepseek-v4-flash",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "glm-5.3",
    title: "GLM-5.3",
    detail: "Official 1M Claude Code mapping with max-length auto compact settings.",
    model: "glm-5.3[1m]",
    keyLabel: "GLM Coding Plan API Key",
  },
  ...activeDeepseekProfiles.map(profile => ({
    id: profile.id as DeepSeekProfilePresetId, title: profile.label, optionLabel: profile.optionLabel,
    detail: profile.description, model: profile.claudeModel, keyLabel: "DeepSeek API Key",
  })),
];

export const CODEX_PROVIDER_DEFINITIONS: CodexProviderDefinition[] = [
  {
    id: "openai-default",
    title: "GPT-Official",
    detail: "Use the existing local Codex account, model, and provider configuration.",
    model: "Local Codex configuration",
  },
  {
    id: "dxx",
    title: "GPT-Dxx",
    detail: "Start with GPT-5.6 Sol; switch to GPT-6 Astra with /model. Uses your saved DXX key.",
    model: "gpt-5.6-sol",
    keyLabel: "DXX API Key",
  },
  {
    id: "dxx-gpt-6-astra",
    title: "DXX · GPT-6 Astra",
    detail: "Start with GPT-6 Astra; switch to GPT-5.6 Sol with /model. Uses your saved DXX key.",
    model: "gpt-6-astra",
    keyLabel: "DXX API Key",
  },
  {
    id: "deepseek-v4-pro",
    hidden: true,
    title: "DeepSeek V4 Pro",
    detail: "Official Responses API routing to DeepSeek-V4-Pro-0813 through one-launch overrides.",
    model: "deepseek-v4-pro",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "deepseek-v4",
    hidden: true,
    title: "DeepSeek V4 Flash",
    detail: "Official Responses API routing through one-launch overrides and AMO's shared model catalog.",
    model: "deepseek-v4-flash",
    keyLabel: "DeepSeek API Key",
  },
  ...activeDeepseekProfiles.map(profile => ({
    id: profile.id as DeepSeekProfilePresetId, title: profile.label, optionLabel: profile.optionLabel,
    detail: profile.description, model: profile.mainModel, keyLabel: "DeepSeek API Key",
  })),
];

export const GROK_PROVIDER_DEFINITIONS: GrokProviderDefinition[] = [
  {
    id: "grok-default",
    title: "Grok Default",
    detail: "Use the existing local Grok Build account, model, and configuration.",
    model: "Local Grok Build configuration",
  },
];

export const STORED_CLAUDE_PROVIDER_IDS: StoredClaudeProviderPresetId[] = [
  "deepseek-v4",
  "glm-coding",
];

export const STORED_MODEL_PROVIDER_IDS: StoredModelProviderId[] = [...STORED_CLAUDE_PROVIDER_IDS, "dxx"];

export const STORED_MODEL_PROVIDER_DEFINITIONS: StoredModelProviderDefinition[] = [
  {
    id: "dxx",
    title: "DXX",
    detail: "One shared DXX API key for the GPT-5.6 Sol and GPT-6 Astra Codex CLI presets.",
    model: "gpt-5.6-sol / gpt-6-astra",
    keyLabel: "DXX API Key",
  },
  {
    id: "deepseek-v4",
    title: "DeepSeek",
    detail: "One shared key for flash-all and pro-flash in Codex CLI and Claude CLI.",
    model: activeDeepseekProfiles[0].subagentModel,
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "glm-coding",
    title: "GLM Coding Plan",
    detail: "Official 1M Claude Code mapping with max-length auto compact settings.",
    model: "glm-5.3[1m]",
    keyLabel: "GLM Coding Plan API Key",
  },
];

export function modelCredentialProviderId(
  presetId: ClaudeProviderPresetId | CodexProviderPresetId | string | null,
): StoredModelProviderId | null {
  if (presetId === "dxx" || presetId === "dxx-gpt-6-astra") return "dxx";
  if (presetId === "deepseek-v4" || presetId === "deepseek-v4-pro") return "deepseek-v4";
  if (presetId && deepseekPresetIds.has(presetId)) return "deepseek-v4";
  if (presetId === "glm-5.3" || presetId === "glm-5.2") return "glm-coding";
  return null;
}

export function isClaudeProviderPresetId(value: string | null): value is ClaudeProviderPresetId {
  return CLAUDE_PROVIDER_DEFINITIONS.some((provider) => provider.id === value) || Boolean(value && deepseekPresetIds.has(value));
}

export function normalizeClaudeProviderPresetId(value: string | null): ClaudeProviderPresetId {
  if (value === "glm-5.2") return "glm-5.3";
  return isClaudeProviderPresetId(value) ? value : "anthropic-default";
}

export function isCodexProviderPresetId(value: string | null): value is CodexProviderPresetId {
  return CODEX_PROVIDER_DEFINITIONS.some((provider) => provider.id === value) || Boolean(value && deepseekPresetIds.has(value));
}

export function loadDefaultClaudeProvider(): ClaudeProviderPresetId {
  try {
    const value = currentDeepseekDefault(localStorage.getItem(DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY));
    const providerId = normalizeClaudeProviderPresetId(value);
    if (value === "glm-5.2") {
      localStorage.setItem(DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY, providerId);
    }
    return providerId;
  } catch {
    return "anthropic-default";
  }
}

export function saveDefaultClaudeProvider(providerId: ClaudeProviderPresetId) {
  try {
    localStorage.setItem(DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY, providerId);
  } catch {
    // Launch still works with the in-memory selection when storage is unavailable.
  }
}

export function loadDefaultCodexProvider(): CodexProviderPresetId {
  try {
    const value = currentDeepseekDefault(localStorage.getItem(DEFAULT_CODEX_PROVIDER_STORAGE_KEY));
    if (!localStorage.getItem(CODEX_ASTRA_DEFAULT_MIGRATION_KEY)) {
      // Move the previous DXX default to Astra once; subsequent explicit choices are retained.
      localStorage.setItem(CODEX_ASTRA_DEFAULT_MIGRATION_KEY, "1");
      if (value === "dxx") {
        localStorage.setItem(DEFAULT_CODEX_PROVIDER_STORAGE_KEY, "dxx-gpt-6-astra");
        return "dxx-gpt-6-astra";
      }
    }
    return isCodexProviderPresetId(value) ? value : "openai-default";
  } catch {
    return "openai-default";
  }
}

export function saveDefaultCodexProvider(providerId: CodexProviderPresetId) {
  try {
    localStorage.setItem(DEFAULT_CODEX_PROVIDER_STORAGE_KEY, providerId);
    localStorage.setItem(CODEX_ASTRA_DEFAULT_MIGRATION_KEY, "1");
  } catch {
    // Launch still works with the in-memory selection when storage is unavailable.
  }
}

export async function loadModelCredentialStatus(): Promise<ModelCredentialStatus> {
  const result = await invoke<ModelCredentialStatus>("model_credential_status", {
    providerIds: STORED_MODEL_PROVIDER_IDS,
  });
  if (!result.ok) {
    throw new Error(result.message || "Credential status could not be loaded.");
  }
  return result;
}

export async function saveModelCredential(
  providerId: StoredModelProviderId,
  apiKey: string,
): Promise<ModelCredentialResult> {
  return invoke<ModelCredentialResult>("save_model_credential", { providerId, apiKey });
}

export async function deleteModelCredential(
  providerId: StoredModelProviderId,
): Promise<ModelCredentialResult> {
  return invoke<ModelCredentialResult>("delete_model_credential", { providerId });
}

export async function resolveModelCredential(
  providerId: StoredModelProviderId,
): Promise<string> {
  const result = await invoke<ModelCredentialResult>("resolve_model_credential", { providerId });
  if (!result.ok || !result.apiKey) {
    throw new Error(result.message || "Stored API key could not be resolved.");
  }
  return result.apiKey;
}
