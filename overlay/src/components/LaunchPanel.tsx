import { useState } from "react";
import { FolderOpen, X } from "lucide-react";
import type { AgentSession, WorkspaceInspection } from "../types";
import type { LaunchPanelAdapterId } from "../domain/workspaceModel";
import type { WorkspaceLaunchMode, WorkspaceLaunchSelection } from "../api/workspaceLaunch";
import { projectName } from "../domain/routingModel";
import { openModelSettingsWindow, openWorkspaceCenterForPath } from "../hooks/useMainUtilityWindows";
import { WorkspaceLaunchForm } from "./WorkspaceLaunchForm";

// Retained as a type alias for existing card callers; the launch contract belongs to the shared API.
export type ManagedLaunchSelection = WorkspaceLaunchSelection;

export interface LaunchPanelState {
  launchMode?: WorkspaceLaunchMode;
  source: "card" | "workspace";
  session: AgentSession | null;
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  initialAdapterId?: LaunchPanelAdapterId;
  busy: "inspect" | "launch" | null;
  error: string | null;
}

interface LaunchPanelProps {
  state: LaunchPanelState;
  onClose: () => void;
  onLaunch: (selection: WorkspaceLaunchSelection, mode: WorkspaceLaunchMode) => Promise<void>;
}

export function LaunchPanel({ state, onClose, onLaunch }: LaunchPanelProps) {
  const [formBusy, setFormBusy] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const busy = state.busy !== null || formBusy;
  async function openSettings() {
    try { await openModelSettingsWindow(); } catch (e) { setNavigationError((e as Error).message); }
  }
  async function openDeployment() {
    try { await openWorkspaceCenterForPath(state.workspacePath); onClose(); }
    catch (e) { setNavigationError((e as Error).message); }
  }
  return <div className="managed-launch-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="workspace-launch-surface wc-quick-launch" role="dialog" aria-modal="true" aria-label="本项目快速启动">
      <header className="wc-quick-header"><div><strong>本项目快速启动</strong><small>{projectName(state.workspacePath)}</small></div>
        <button type="button" className="wc-icon-button" aria-label="关闭快速启动" disabled={busy} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="wc-quick-body">
        <div className="wc-path"><FolderOpen size={14} /><span title={state.workspacePath}>{state.workspacePath || "此任务尚未关联工作区"}</span></div>
        {state.source === "card" && state.session && <p className="wc-help wc-quick-source">来源任务：{state.session.taskTitle || state.session.title}</p>}
        {navigationError && <p className="wc-error" role="alert">{navigationError}</p>}
        <WorkspaceLaunchForm key={`${state.session?.sessionId || "workspace"}:${state.workspacePath}:${state.initialAdapterId}`}
          workspacePath={state.inspection?.workspacePath || state.workspacePath} inspection={state.inspection}
          busy={state.busy !== null} initialAdapterId={state.initialAdapterId} initialMode={state.launchMode || "managed"} externalError={state.error}
          onLaunch={onLaunch} onDeploy={() => void openDeployment()} onCredentials={() => void openSettings()} onBusyChange={setFormBusy} />
      </div>
    </section>
  </div>;
}
