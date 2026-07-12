import { X } from "lucide-react";
import {
  cliLaunchLabel,
  workspaceAdapterLaunchDetail,
  workspaceAdapterLaunchable,
  type LaunchPanelAdapterId,
} from "../domain/workspaceModel";
import { projectName, shortPathLabel, workspacePathForSession } from "../domain/routingModel";
import type { AgentSession, WorkspaceInspection } from "../types";
import { LaunchToolMark } from "./SessionCard";

export interface LaunchPanelState {
  session: AgentSession;
  x: number;
  y: number;
  inspection: WorkspaceInspection | null;
  busy: "inspect" | LaunchPanelAdapterId | null;
  error: string | null;
}

interface LaunchPanelProps {
  state: LaunchPanelState;
  onClose: () => void;
  onLaunch: (adapterId: LaunchPanelAdapterId) => void;
}

export function LaunchPanel({ state, onClose, onLaunch }: LaunchPanelProps) {
  const workspacePath = state.inspection?.workspacePath ?? workspacePathForSession(state.session);

  return (
    <section
      className="launch-panel"
      style={{ left: state.x, top: state.y }}
      aria-label="Project launch"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="launch-panel-header">
        <div>
          <strong>{projectName(workspacePath)}</strong>
          <span>{state.busy === "inspect" ? "Checking deploy status" : "New managed CLI"}</span>
        </div>
        <button type="button" className="candidate-close" title="Close" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <code className="launch-panel-path" title={workspacePath}>
        {shortPathLabel(workspacePath)}
      </code>

      {state.error ? <p className="launch-panel-error">{state.error}</p> : null}

      <div className="launch-panel-actions">
        {(["codex-cli", "claude-cli"] as LaunchPanelAdapterId[]).map((adapterId) => {
          const launchable = workspaceAdapterLaunchable(state.inspection, adapterId);
          const checking = state.busy === "inspect";
          const busy = state.busy === adapterId;
          const panelBusy = state.busy !== null;
          return (
            <button
              type="button"
              key={adapterId}
              disabled={panelBusy || !launchable}
              onClick={() => onLaunch(adapterId)}
            >
              <LaunchToolMark adapterId={adapterId} />
              <span>
                <strong>{busy ? "Starting" : `Managed ${cliLaunchLabel(adapterId)}`}</strong>
                <small>{checking ? "checking" : workspaceAdapterLaunchDetail(state.inspection, adapterId)}</small>
              </span>
            </button>
          );
        })}
      </div>

      {state.inspection ? (
        <span className="launch-panel-note">Managed CLI starts in the project directory and waits for its own hook-created card.</span>
      ) : (
        <span className="launch-panel-note">Inspecting deployment before enabling launch actions.</span>
      )}
    </section>
  );
}
