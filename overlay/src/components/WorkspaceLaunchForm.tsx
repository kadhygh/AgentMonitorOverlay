import { useEffect, useState } from "react";
import { ArrowUpRight, KeyRound, Play, Monitor } from "lucide-react";
import { LaunchToolMark } from "./SessionCard";
import type { WorkspaceLaunchSelection, WorkspaceLaunchMode } from "../api/workspaceLaunch";
import { workspaceAdapterLaunchable, workspaceLaunchLabel, type LaunchPanelAdapterId } from "../domain/workspaceModel";
import { workspaceLaunchRoutes, workspaceLaunchModelLabel } from "../domain/workspaceLaunchRoutes";
import { loadDefaultClaudeProvider, loadDefaultCodexProvider, loadModelCredentialStatus, modelCredentialProviderId, type CodexProviderPresetId, type ClaudeProviderPresetId } from "../native/modelProviders";
import type { WorkspaceInspection } from "../types";

interface Props {
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  busy: boolean;
  initialAdapterId?: LaunchPanelAdapterId;
  initialMode?: WorkspaceLaunchMode;
  externalError?: string | null;
  onLaunch: (selection: WorkspaceLaunchSelection, mode: WorkspaceLaunchMode) => Promise<void>;
  onDeploy: () => void;
  onCredentials: () => void;
  onBusyChange: (busy: boolean) => void;
}

export function WorkspaceLaunchForm({ workspacePath, inspection, busy, initialAdapterId = "codex-cli", initialMode, externalError, onLaunch, onDeploy, onCredentials, onBusyChange }: Props) {
  const [adapterId, setAdapterId] = useState<LaunchPanelAdapterId>(initialAdapterId);
  const [modeChoice, setModeChoice] = useState<"managed" | "cli-only" | null>(null);
  const [codex, setCodex] = useState(loadDefaultCodexProvider);
  const [claude, setClaude] = useState(loadDefaultClaudeProvider);
  const [keys, setKeys] = useState<string[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [keyError, setKeyError] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [overrideKey, setOverrideKey] = useState(false);
  const [launching, setLaunching] = useState(false);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      setLoadingKeys(true);
      try {
        const result = await loadModelCredentialStatus();
        if (!disposed) { setKeys(result.configuredProviderIds); setKeyError(""); }
      } catch (e) { if (!disposed) setKeyError(`无法读取已保存凭据：${(e as Error).message}`); }
      finally { if (!disposed) setLoadingKeys(false); }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { disposed = true; window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => { setModeChoice(null); setApiKey(""); setError(""); setOverrideKey(false); }, [workspacePath]);
  const isApp = adapterId === "codex-app";
  const clientLabel = isApp ? "GPT App" : workspaceLaunchLabel(adapterId);
  const groups = workspaceLaunchRoutes(isApp ? "codex-cli" : adapterId);
  const presetId = isApp ? "openai-default" : adapterId === "codex-cli" ? codex : adapterId === "claude-cli" ? claude : "grok-default";
  const route = groups.find(group => group.models.some(model => model.id === presetId)) || groups[0];
  const provider = route.models.find(model => model.id === presetId) || route.models[0];
  const selectedModelLabel = provider.optionLabel || workspaceLaunchModelLabel(provider.model);
  const credentialId = modelCredentialProviderId(presetId);
  const configured = Boolean(credentialId && keys.includes(credentialId));
  const installed = workspaceAdapterLaunchable(inspection, adapterId);
  const mode = isApp ? "managed" : modeChoice ?? initialMode ?? (inspection?.existingEnrollment ? "managed" : "cli-only");
  const blocked = busy || launching;
  const missingKey = Boolean(credentialId && !configured && !apiKey.trim());
  const canLaunch = Boolean(workspacePath.trim()) && (mode === "cli-only" || installed) && !missingKey && !blocked;

  function selectPreset(value: string) {
    if (adapterId === "codex-cli") setCodex(value as CodexProviderPresetId);
    if (adapterId === "claude-cli") setClaude(value as ClaudeProviderPresetId);
    setApiKey(""); setOverrideKey(false); setError("");
  }
  async function launch() {
    if (!canLaunch) return;
    setLaunching(true); onBusyChange(true); setError("");
    try {
      await onLaunch({ adapterId,
        codexProvider: adapterId === "codex-cli" ? { presetId: codex, apiKey: apiKey.trim() || undefined } : undefined,
        claudeProvider: adapterId === "claude-cli" ? { presetId: claude, apiKey: apiKey.trim() || undefined } : undefined,
      }, mode);
      setApiKey(""); setOverrideKey(false);
    } catch (e) { setError((e as Error).message); }
    finally { setLaunching(false); onBusyChange(false); }
  }
  return <div className="wc-launch-form">
    <h2>选择客户端</h2>
    <div className="wc-clients" aria-label="启动客户端">
      {(["codex-cli", "claude-cli", "grok-build", "codex-app"] as const).map(id => {
        const adapter = inspection?.supportedAdapters.find(item => item.id === id);
        const status = !inspection ? "等待检查" : adapter?.deploymentStatus === "needs-update" ? "接入可更新"
          : workspaceAdapterLaunchable(inspection, id) ? "已接入 AMO" : "未接入 AMO";
        return <button type="button" key={id} aria-pressed={adapterId === id} disabled={blocked}
          onClick={() => { setAdapterId(id); setApiKey(""); setOverrideKey(false); setError(""); }}>
          <LaunchToolMark adapterId={id} compact /><span><strong>{id === "codex-app" ? "GPT App" : workspaceLaunchLabel(id)}</strong><small>{id === "codex-app" ? "ChatGPT 桌面应用" : status}</small></span>
        </button>;
      })}
    </div>
    {isApp ? <div className="wc-app-info"><Monitor size={20} /><div><h2>在 GPT App 中打开本项目</h2><p className="wc-help">在 ChatGPT 桌面应用中创建新任务，使用 App 内的账号和模型设置。</p></div></div> : <>
    <div className="wc-mode-row"><h2>启动方式</h2><div className="wc-segment" aria-label="启动方式">
      <button type="button" aria-pressed={mode === "managed"} disabled={blocked} onClick={() => setModeChoice("managed")}>AMO 受管</button>
      <button type="button" aria-pressed={mode === "cli-only"} disabled={blocked} onClick={() => setModeChoice("cli-only")}>普通 CLI</button>
    </div></div>
    <p className="wc-help">{mode === "managed" ? "跟踪任务状态，通过 Hooks 收集 Prompt 与回复。" : "直接在当前目录启动，无需部署；已有 Hooks 仍可能上报事件。"}</p>
    <div className="wc-fields">
      <label><span>模型路由</span><select aria-label="模型路由" value={route.id} disabled={blocked || groups.length === 1}
        onChange={e => { const next = groups.find(group => group.id === e.target.value)!; selectPreset(next.id === "dxx" ? "dxx-gpt-6-astra" : next.models[0].id); }}>
        {groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}
      </select></label>
      <label><span>{route.id === "deepseek-v4" ? "路由模式" : "启动模型"}</span><select aria-label={route.id === "deepseek-v4" ? "路由模式" : "启动模型"} value={provider.id} disabled={blocked || route.models.length === 1} onChange={e => selectPreset(e.target.value)}>
        {route.models.map(model => <option key={model.id} value={model.id}>{model.optionLabel || workspaceLaunchModelLabel(model.model)}</option>)}
      </select></label>
    </div>
    {provider.optionLabel && <p className="wc-help wc-routing-detail">{provider.detail}</p>}
    <div className="wc-credentials"><KeyRound size={14} /><span>{!credentialId ? "使用本机登录与模型配置" : loadingKeys ? "正在检查凭据…" : configured ? `使用已保存的 ${provider.keyLabel}` : `需要 ${provider.keyLabel}`}</span>
      {credentialId && <button type="button" className="wc-link" disabled={blocked} onClick={onCredentials}>凭据设置 <ArrowUpRight size={13} /></button>}
    </div>
    {credentialId && <>
      {keyError && <p className="wc-error" role="alert">{keyError}</p>}
      {configured && <button type="button" className="wc-link wc-key-toggle" disabled={blocked} onClick={() => { setOverrideKey(!overrideKey); setApiKey(""); }}>本次使用其他 Key</button>}
      {(!configured || overrideKey) && <label className="wc-key-field"><span>{provider.keyLabel} · 仅用于本次启动</span><input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={blocked}
        onChange={e => setApiKey(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void launch(); }} placeholder="输入 API Key，或在凭据设置中保存" /></label>}
    </>}
    </>}
    {mode === "managed" && !installed && <div className="wc-notice"><span>{isApp ? "请先检查工作区并完成 Codex 接入，再从此处打开 GPT App。" : inspection ? "当前客户端尚未接入 AMO。可先普通启动，或前往接入。" : "先检查工作区，确认接入状态后再受管启动。"}</span><button type="button" className="wc-link" disabled={blocked} onClick={onDeploy}>前往接入 →</button></div>}
    {(externalError || error) && <p className="wc-error" role="alert">{externalError || error}</p>}
    <div className="wc-launch-footer"><div><strong>{clientLabel} · {isApp ? "本项目新任务" : selectedModelLabel}</strong><small>{isApp ? "沿用 App 内的账号和模型设置" : `使用当前终端偏好 · ${mode === "managed" ? "AMO 受管启动" : "普通 CLI"}`}</small></div>
      <button type="button" className="wc-button wc-primary" disabled={!canLaunch} onClick={() => void launch()}>{isApp ? <Monitor size={15} /> : <Play size={15} />}{launching ? "正在启动…" : isApp ? "打开 GPT App" : `启动 ${clientLabel}`}</button>
    </div>
  </div>;
}
