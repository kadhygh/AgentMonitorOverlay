import { invoke } from "@tauri-apps/api/core";

export type ClaudeProviderPresetId = "anthropic-default" | "deepseek-v4-pro" | "deepseek-v4" | "glm-5.3";
export type CodexProviderPresetId = "openai-default" | "deepseek-v4-pro" | "deepseek-v4";
export type GrokProviderPresetId = "grok-default";
export type StoredModelProviderId = "deepseek-v4" | "glm-coding";
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
  id: ClaudeProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
}

export interface CodexProviderDefinition {
  id: CodexProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
}

export interface GrokProviderDefinition {
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

export const CLAUDE_PROVIDER_DEFINITIONS: ClaudeProviderDefinition[] = [
  {
    id: "anthropic-default",
    title: "Claude default",
    detail: "Use the existing local Claude Code account and configuration.",
    model: "Local Claude configuration",
  },
  {
    id: "deepseek-v4-pro",
    title: "DeepSeek V4 Pro",
    detail: "Official Claude Code mapping: V4 Pro for main, Opus, and Sonnet; V4 Flash for Haiku and subagents.",
    model: "deepseek-v4-pro[1m]",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "deepseek-v4",
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
];

export const CODEX_PROVIDER_DEFINITIONS: CodexProviderDefinition[] = [
  {
    id: "openai-default",
    title: "Codex default",
    detail: "Use the existing local Codex account, model, and provider configuration.",
    model: "Local Codex configuration",
  },
  {
    id: "deepseek-v4-pro",
    title: "DeepSeek V4 Pro",
    detail: "Official Responses API routing to DeepSeek-V4-Pro-0813 through one-launch overrides.",
    model: "deepseek-v4-pro",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "deepseek-v4",
    title: "DeepSeek V4 Flash",
    detail: "Official Responses API routing through one-launch overrides and AMO's shared model catalog.",
    model: "deepseek-v4-flash",
    keyLabel: "DeepSeek API Key",
  },
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

export const STORED_MODEL_PROVIDER_IDS: StoredModelProviderId[] = STORED_CLAUDE_PROVIDER_IDS;

export const STORED_MODEL_PROVIDER_DEFINITIONS: StoredModelProviderDefinition[] = [
  {
    id: "deepseek-v4",
    title: "DeepSeek V4",
    detail: "One shared DeepSeek API key for the V4 Pro and V4 Flash Codex and Claude launch presets.",
    model: "deepseek-v4-pro / deepseek-v4-flash",
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
  if (presetId === "deepseek-v4" || presetId === "deepseek-v4-pro") return "deepseek-v4";
  if (presetId === "glm-5.3" || presetId === "glm-5.2") return "glm-coding";
  return null;
}

export function isClaudeProviderPresetId(value: string | null): value is ClaudeProviderPresetId {
  return CLAUDE_PROVIDER_DEFINITIONS.some((provider) => provider.id === value);
}

export function normalizeClaudeProviderPresetId(value: string | null): ClaudeProviderPresetId {
  if (value === "glm-5.2") return "glm-5.3";
  return isClaudeProviderPresetId(value) ? value : "anthropic-default";
}

export function isCodexProviderPresetId(value: string | null): value is CodexProviderPresetId {
  return CODEX_PROVIDER_DEFINITIONS.some((provider) => provider.id === value);
}

export function loadDefaultClaudeProvider(): ClaudeProviderPresetId {
  try {
    const value = localStorage.getItem(DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY);
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
    const value = localStorage.getItem(DEFAULT_CODEX_PROVIDER_STORAGE_KEY);
    return isCodexProviderPresetId(value) ? value : "openai-default";
  } catch {
    return "openai-default";
  }
}

export function saveDefaultCodexProvider(providerId: CodexProviderPresetId) {
  try {
    localStorage.setItem(DEFAULT_CODEX_PROVIDER_STORAGE_KEY, providerId);
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
