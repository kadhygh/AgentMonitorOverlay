import { invoke } from "@tauri-apps/api/core";
import { BROKER_WORKSPACE_LAUNCH_URL, postBrokerJson } from "./brokerClient";
import { cliLaunchPreferencePayload, type CliLaunchEnvironment } from "../native/cliLaunch";
import {
  isClaudeProviderPresetId, isCodexProviderPresetId, modelCredentialProviderId, resolveModelCredential,
  type ClaudeProviderLaunchConfig, type CodexProviderLaunchConfig, type StoredModelProviderId,
} from "../native/modelProviders";
import { workspaceAdapterLaunchable, workspaceLaunchLabel, type LaunchPanelAdapterId } from "../domain/workspaceModel";
import type { OpenPathResult, WorkspaceInspection, WorkspaceLaunchResult } from "../types";

export type WorkspaceLaunchMode = "managed" | "cli-only";

export interface WorkspaceLaunchSelection {
  adapterId: LaunchPanelAdapterId;
  claudeProvider?: ClaudeProviderLaunchConfig;
  codexProvider?: CodexProviderLaunchConfig;
}

export interface WorkspaceLaunchRequest {
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  selection: WorkspaceLaunchSelection;
  launchMode: WorkspaceLaunchMode;
  sourceCardSessionId?: string;
}

export interface WorkspaceLaunchPayload extends WorkspaceLaunchSelection {
  workspacePath: string;
  launchMode: WorkspaceLaunchMode;
  launchEnvironment: CliLaunchEnvironment;
  sourceCardSessionId?: string;
}

interface WorkspaceLaunchDependencies {
  resolveCredential: (id: StoredModelProviderId) => Promise<string>;
  launchPreference: typeof cliLaunchPreferencePayload;
  postLaunch: (payload: WorkspaceLaunchPayload) => Promise<WorkspaceLaunchResult>;
  openUri: (uri: string) => Promise<OpenPathResult>;
  rememberPath: (path: string) => void;
}

const defaultDependencies: WorkspaceLaunchDependencies = {
  resolveCredential: resolveModelCredential,
  launchPreference: cliLaunchPreferencePayload,
  postLaunch: payload => postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, payload),
  openUri: uri => invoke<OpenPathResult>("open_uri", { uri }),
  rememberPath: path => {
    try { localStorage.setItem("amo.cli.lastWorkspacePath", path); } catch { /* Optional preference. */ }
  },
};

function sameWorkspace(left: string, right: string) {
  const normalize = (value: string) => value.trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/** All new-workspace launch entrypoints use this boundary, including card shortcuts. */
export async function launchWorkspaceTool(request: WorkspaceLaunchRequest, overrides: Partial<WorkspaceLaunchDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const workspacePath = request.workspacePath.trim();
  const { adapterId } = request.selection;
  if (!workspacePath) throw new Error("请选择工作区目录。");
  if (!["codex-cli", "claude-cli", "grok-build", "codex-app"].includes(adapterId)) throw new Error("不支持的启动客户端。");
  if (!["managed", "cli-only"].includes(request.launchMode)) throw new Error("不支持的启动方式。");
  if (request.launchMode === "cli-only" && adapterId === "codex-app") throw new Error("普通 CLI 模式不支持 ChatGPT 桌面应用。");
  if (request.launchMode === "managed" && (!request.inspection
    || !sameWorkspace(request.inspection.workspacePath, workspacePath)
    || !workspaceAdapterLaunchable(request.inspection, adapterId))) {
    throw new Error(`${workspaceLaunchLabel(adapterId)} 尚未在当前工作区接入，请先检查并部署。`);
  }

  const payload: WorkspaceLaunchPayload = {
    workspacePath, adapterId, launchMode: request.launchMode, ...dependencies.launchPreference(),
    ...(request.launchMode === "managed" && request.sourceCardSessionId ? { sourceCardSessionId: request.sourceCardSessionId } : {}),
  };
  // Resolve only the active client's credential. Hidden/stale selections never leak across clients.
  if (adapterId === "codex-cli" || adapterId === "claude-cli") {
    const config = adapterId === "codex-cli" ? request.selection.codexProvider : request.selection.claudeProvider;
    const presetId = config?.presetId || (adapterId === "codex-cli" ? "openai-default" : "anthropic-default");
    const valid = adapterId === "codex-cli" ? isCodexProviderPresetId(presetId) : isClaudeProviderPresetId(presetId);
    if (!valid) throw new Error(`不支持的模型预设：${presetId}`);
    const credentialId = modelCredentialProviderId(presetId);
    const apiKey = credentialId ? (config?.apiKey?.trim() || await dependencies.resolveCredential(credentialId)) : undefined;
    if (credentialId && !apiKey?.trim()) throw new Error("缺少 API Key，请在凭据设置中保存，或输入本次启动的 Key。");
    const resolved = { presetId, ...(apiKey ? { apiKey } : {}) };
    if (adapterId === "codex-cli") payload.codexProvider = resolved as CodexProviderLaunchConfig;
    else payload.claudeProvider = resolved as ClaudeProviderLaunchConfig;
  }

  const result = await dependencies.postLaunch(payload);
  if (!result.ok) throw new Error(result.message || "启动失败。");
  if (adapterId === "codex-app") {
    if (!result.uri) throw new Error("Broker did not return a ChatGPT workspace URI.");
    const opened = await dependencies.openUri(result.uri);
    if (!opened.ok) throw new Error(opened.message);
  }
  if (request.launchMode === "cli-only") dependencies.rememberPath(result.workspacePath);
  return result;
}
