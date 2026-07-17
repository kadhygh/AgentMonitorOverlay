import { invoke } from "@tauri-apps/api/core";

export type ClaudeProviderPresetId = "anthropic-default" | "deepseek-v4" | "glm-5.2";
export type StoredClaudeProviderPresetId = Exclude<ClaudeProviderPresetId, "anthropic-default">;

export interface ClaudeProviderLaunchConfig {
  presetId: ClaudeProviderPresetId;
  apiKey?: string;
}

export interface ClaudeProviderDefinition {
  id: ClaudeProviderPresetId;
  title: string;
  detail: string;
  model: string;
  keyLabel?: string;
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

export const CLAUDE_PROVIDER_DEFINITIONS: ClaudeProviderDefinition[] = [
  {
    id: "anthropic-default",
    title: "Claude default",
    detail: "Use the existing local Claude Code account and configuration.",
    model: "Local Claude configuration",
  },
  {
    id: "deepseek-v4",
    title: "DeepSeek V4 Pro",
    detail: "Official 1M Claude Code mapping, with V4 Flash for Haiku and subagents.",
    model: "deepseek-v4-pro[1m]",
    keyLabel: "DeepSeek API Key",
  },
  {
    id: "glm-5.2",
    title: "GLM-5.2",
    detail: "Official 1M Claude Code mapping with max-length auto compact settings.",
    model: "glm-5.2[1m]",
    keyLabel: "GLM Coding Plan API Key",
  },
];

export const STORED_CLAUDE_PROVIDER_IDS: StoredClaudeProviderPresetId[] = [
  "deepseek-v4",
  "glm-5.2",
];

export function isClaudeProviderPresetId(value: string | null): value is ClaudeProviderPresetId {
  return CLAUDE_PROVIDER_DEFINITIONS.some((provider) => provider.id === value);
}

export function loadDefaultClaudeProvider(): ClaudeProviderPresetId {
  try {
    const value = localStorage.getItem(DEFAULT_CLAUDE_PROVIDER_STORAGE_KEY);
    return isClaudeProviderPresetId(value) ? value : "anthropic-default";
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

export async function loadModelCredentialStatus(): Promise<ModelCredentialStatus> {
  const result = await invoke<ModelCredentialStatus>("model_credential_status", {
    providerIds: STORED_CLAUDE_PROVIDER_IDS,
  });
  if (!result.ok) {
    throw new Error(result.message || "Credential status could not be loaded.");
  }
  return result;
}

export async function saveModelCredential(
  providerId: StoredClaudeProviderPresetId,
  apiKey: string,
): Promise<ModelCredentialResult> {
  return invoke<ModelCredentialResult>("save_model_credential", { providerId, apiKey });
}

export async function deleteModelCredential(
  providerId: StoredClaudeProviderPresetId,
): Promise<ModelCredentialResult> {
  return invoke<ModelCredentialResult>("delete_model_credential", { providerId });
}

export async function resolveModelCredential(
  providerId: StoredClaudeProviderPresetId,
): Promise<string> {
  const result = await invoke<ModelCredentialResult>("resolve_model_credential", { providerId });
  if (!result.ok || !result.apiKey) {
    throw new Error(result.message || "Stored API key could not be resolved.");
  }
  return result.apiKey;
}
