import { AlertTriangle, CircleCheck, FolderOpen, RefreshCcw, Trash2, X } from "lucide-react";
import { pluginHealthTitle, projectName, shortPathLabel, workspacePathForSession } from "../domain/routingModel";
import { maintenanceToneForSession } from "../domain/workspaceModel";
import type { AgentSession, WorkspaceMaintenanceStatus } from "../types";

export interface WorkspacePanelState {
  session: AgentSession;
  x: number;
  y: number;
  status: WorkspaceMaintenanceStatus | null;
  busy: "status" | "clean" | "open" | "task-title" | "plugin-update" | null;
  error: string | null;
  taskTitleDraft: string;
}

interface WorkspacePanelProps {
  state: WorkspacePanelState;
  onClose: () => void;
  onTaskTitleDraftChange: (draft: string) => void;
  onSaveTaskTitle: (overrideTaskTitle?: string) => void;
  onLoadStatus: () => void;
  onOpenPath: (path: string | undefined, label: string) => void;
  onRequestClean: () => void;
  onUpdatePlugin: () => void;
}

export function WorkspacePanel({
  state,
  onClose,
  onTaskTitleDraftChange,
  onSaveTaskTitle,
  onLoadStatus,
  onOpenPath,
  onRequestClean,
  onUpdatePlugin,
}: WorkspacePanelProps) {
  const pluginHealth = state.status?.pluginHealth;
  const pluginNeedsUpdate = Boolean(
    pluginHealth &&
      !pluginHealth.ok &&
      state.status?.exists.vaultRoot &&
      (pluginHealth.installedVersion !== pluginHealth.expectedVersion ||
        pluginHealth.status === "missing" ||
        pluginHealth.mainJsExists === false ||
        pluginHealth.enabled === false ||
        pluginHealth.dataBridgeUrl !== pluginHealth.expectedBridgeUrl),
  );

  return (
    <div className="workspace-panel-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`workspace-panel tone-${maintenanceToneForSession(state.session, state.status)}`}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace maintenance"
        onClick={(event) => event.stopPropagation()}
      >
      <div className="workspace-panel-header">
        <div>
          <strong>{projectName(workspacePathForSession(state.session))}</strong>
          <span>{state.status ? (state.status.ok ? "Ready" : "Needs review") : "Checking"}</span>
        </div>
        <button type="button" className="candidate-close" title="Close" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="workspace-task-title-editor">
        <label>
          <span>任务名</span>
          <input
            type="text"
            value={state.taskTitleDraft}
            placeholder={state.session.title}
            disabled={state.busy !== null}
            onChange={(event) => onTaskTitleDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSaveTaskTitle();
              }
            }}
          />
        </label>
        <button type="button" disabled={state.busy !== null} onClick={() => onSaveTaskTitle()}>
          Save
        </button>
        <button
          type="button"
          disabled={state.busy !== null || !state.session.taskTitle}
          onClick={() => onSaveTaskTitle("")}
        >
          Clear
        </button>
      </div>

      <div className="workspace-panel-actions">
        <button type="button" disabled={state.busy !== null} onClick={onLoadStatus}>
          <RefreshCcw size={12} aria-hidden="true" />
          <span>{state.busy === "status" ? "Checking" : "Check"}</span>
        </button>
        <button
          type="button"
          disabled={state.busy !== null}
          onClick={() => onOpenPath(state.status?.paths.workspace ?? workspacePathForSession(state.session), "workspace")}
        >
          <FolderOpen size={12} aria-hidden="true" />
          <span>Project</span>
        </button>
        <button
          type="button"
          disabled={state.busy !== null}
          onClick={() => onOpenPath(state.status?.paths.vaultRoot ?? state.session.vaultRoot, "vault")}
        >
          <FolderOpen size={12} aria-hidden="true" />
          <span>Vault</span>
        </button>
        <button type="button" className="danger-action" disabled={state.busy !== null} onClick={onRequestClean}>
          <Trash2 size={12} aria-hidden="true" />
          <span>{state.busy === "clean" ? "Cleaning" : "Clean"}</span>
        </button>
      </div>

      {state.error ? <p className="workspace-panel-error">{state.error}</p> : null}

      {state.status ? (
        <div className="workspace-panel-content">
          <div className="workspace-stats">
            <span>
              <strong>{state.status.counts.sessionFolders ?? 0}</strong>
              Sessions
            </span>
            <span>
              <strong>{state.status.counts.replyNotes}</strong>
              Replies
            </span>
            <span>
              <strong>{state.status.counts.promptNotes}</strong>
              Prompts
            </span>
            <span>
              <strong>{state.status.counts.canvasNodes}</strong>
              Nodes
            </span>
          </div>

          <div className="workspace-section">
            <strong>Folders</strong>
            <div className="workspace-path-grid">
              <span className={state.status.exists.amoRoot ? "is-ok" : "is-bad"}>.amo</span>
              <code title={state.status.paths.amoRoot}>{shortPathLabel(state.status.paths.amoRoot)}</code>
              <span className={state.status.exists.vaultRoot ? "is-ok" : "is-bad"}>vault</span>
              <code title={state.status.paths.vaultRoot}>{shortPathLabel(state.status.paths.vaultRoot)}</code>
              <span className={state.status.exists.sessions ? "is-ok" : "is-bad"}>Sessions</span>
              <code title={state.status.paths.sessions}>{shortPathLabel(state.status.paths.sessions)}</code>
              <span className={state.status.exists.generated ? "is-ok" : "is-bad"}>Generated</span>
              <code title={state.status.paths.generated}>{shortPathLabel(state.status.paths.generated)}</code>
              <span className={state.status.exists.workCanvases ? "is-ok" : "is-bad"}>Work</span>
              <code title={state.status.paths.workCanvases}>{shortPathLabel(state.status.paths.workCanvases)}</code>
            </div>
          </div>

          <div className="workspace-section">
            <strong>Canvas</strong>
            <span className={`workspace-health-line ${state.status.canvas.amoManaged ? "is-ok" : "is-bad"}`}>
              {state.status.canvas.amoManaged ? <CircleCheck size={12} /> : <AlertTriangle size={12} />}
              {state.status.canvas.amoManaged ? "AMO managed" : "AMO marker missing"}
            </span>
            {state.status.canvas.marker ? (
              <code className="workspace-code-line">
                {state.status.canvas.marker.managedBy} / {state.status.canvas.marker.canvasType}
              </code>
            ) : null}
          </div>

          <div className="workspace-section">
            <strong>Plugin</strong>
            <span
              className={`workspace-health-line ${state.status.pluginHealth?.ok ? "is-ok" : "is-warning"}`}
              title={state.status.pluginHealth ? pluginHealthTitle(state.status.pluginHealth) : undefined}
            >
              {state.status.pluginHealth?.ok ? <CircleCheck size={12} /> : <AlertTriangle size={12} />}
              {state.status.pluginHealth?.installedVersion ?? "missing"} / expected{" "}
              {state.status.pluginHealth?.expectedVersion ?? "unknown"}
            </span>
            {pluginNeedsUpdate ? (
              <button
                type="button"
                className="workspace-inline-action"
                disabled={state.busy !== null}
                onClick={onUpdatePlugin}
                title="Copy the bundled AMO Obsidian plugin into this workspace vault without redeploying hooks."
              >
                <RefreshCcw size={12} aria-hidden="true" />
                <span>{state.busy === "plugin-update" ? "Updating plugin" : "Update plugin"}</span>
              </button>
            ) : null}
          </div>

          {state.status.issues.length > 0 ? (
            <div className="workspace-section">
              <strong>Issues</strong>
              <div className="workspace-issues">
                {state.status.issues.slice(0, 5).map((issue) => (
                  <span key={issue}>{issue}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="workspace-panel-loading">Checking workspace folders...</div>
      )}
      </section>
    </div>
  );
}
