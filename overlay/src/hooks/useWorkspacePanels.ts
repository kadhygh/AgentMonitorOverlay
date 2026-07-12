import { type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BROKER_WORKSPACE_CLEAN_VAULT_URL,
  BROKER_WORKSPACE_INSPECT_URL,
  BROKER_WORKSPACE_LAUNCH_URL,
  BROKER_WORKSPACE_STATUS_URL,
  BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL,
  brokerSessionTaskTitleUrl,
  postBrokerJson,
} from "../api/brokerClient";
import { launchPanelPosition, workspacePanelPosition } from "../domain/overlaySessionUi";
import { projectName, workspacePathForSession } from "../domain/routingModel";
import {
  cliLaunchLabel,
  workspaceAdapterLaunchable,
  workspaceCleanFeedback,
  type LaunchPanelAdapterId,
} from "../domain/workspaceModel";
import type { CandidateMenuState } from "../components/CandidateMenu";
import type { CleanConfirmState } from "../components/CleanConfirmDialog";
import type { LaunchPanelState } from "../components/LaunchPanel";
import type { WorkspacePanelState } from "../components/WorkspacePanel";
import type {
  AgentSession,
  OpenPathResult,
  WorkspaceCleanResult,
  WorkspaceInspection,
  WorkspaceLaunchResult,
  WorkspaceMaintenanceStatus,
  WorkspacePluginUpdateResult,
} from "../types";

interface UseWorkspacePanelsOptions {
  launchPanel: LaunchPanelState | null;
  postDebugLog: (event: string, data?: unknown) => void;
  refreshSessions: (reason?: string) => Promise<void>;
  setCandidateMenu: Dispatch<SetStateAction<CandidateMenuState | null>>;
  setCleanConfirm: Dispatch<SetStateAction<CleanConfirmState | null>>;
  setFeedback: Dispatch<SetStateAction<string>>;
  setLaunchPanel: Dispatch<SetStateAction<LaunchPanelState | null>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
  setWorkspacePanel: Dispatch<SetStateAction<WorkspacePanelState | null>>;
  workspacePanel: WorkspacePanelState | null;
}

export function useWorkspacePanels(options: UseWorkspacePanelsOptions) {
  async function openWorkspacePanel(session: AgentSession, x?: number, y?: number) {
    const position = workspacePanelPosition(x, y);
    options.setCandidateMenu(null);
    options.setLaunchPanel(null);
    options.setWorkspacePanel({
      session,
      x: position.x,
      y: position.y,
      status: null,
      busy: "status",
      error: null,
      taskTitleDraft: session.taskTitle ?? "",
    });
    await loadWorkspaceStatus(session);
  }

  async function openLaunchPanel(session: AgentSession, x?: number, y?: number) {
    const position = launchPanelPosition(x, y);
    options.setCandidateMenu(null);
    options.setWorkspacePanel(null);
    options.setLaunchPanel({
      session,
      x: position.x,
      y: position.y,
      inspection: null,
      busy: "inspect",
      error: null,
    });
    await loadLaunchPanelInspection(session);
  }

  async function loadLaunchPanelInspection(session: AgentSession) {
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      options.setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: "No workspace path is linked to this card." }
          : current,
      );
      return;
    }

    options.setLaunchPanel((current) =>
      current && current.session.sessionId === session.sessionId ? { ...current, busy: "inspect", error: null } : current,
    );

    try {
      const inspection = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath,
      });
      options.setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, inspection, busy: null, error: null }
          : current,
      );
      options.postDebugLog("workspace.launch_panel.inspect.ok", {
        sessionId: session.sessionId,
        workspacePath: inspection.workspacePath,
      });
    } catch (error) {
      const message = (error as Error).message;
      options.setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId ? { ...current, busy: null, error: message } : current,
      );
      options.postDebugLog("workspace.launch_panel.inspect.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  async function launchProjectCliFromPanel(adapterId: LaunchPanelAdapterId) {
    if (!options.launchPanel) return;

    const session = options.launchPanel.session;
    const workspacePath = options.launchPanel.inspection?.workspacePath ?? workspacePathForSession(session);
    if (!workspacePath) {
      options.setLaunchPanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    if (!workspaceAdapterLaunchable(options.launchPanel.inspection, adapterId)) {
      options.setLaunchPanel((current) =>
        current ? { ...current, error: `${cliLaunchLabel(adapterId)} is not deployed in this workspace.` } : current,
      );
      return;
    }

    options.setLaunchPanel((current) => (current ? { ...current, busy: adapterId, error: null } : current));
    options.setFeedback(`Launching new ${cliLaunchLabel(adapterId)} for ${projectName(workspacePath)}...`);
    options.postDebugLog("workspace.launch_panel.launch.start", {
      sessionId: session.sessionId,
      workspacePath,
      adapterId,
    });

    try {
      const result = await postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, {
        workspacePath,
        adapterId,
        sourceCardSessionId: session.sessionId,
      });
      options.postDebugLog("workspace.launch_panel.launch.ok", {
        sessionId: session.sessionId,
        workspacePath: result.workspacePath,
        adapterId: result.adapterId,
        pid: result.pid ?? null,
      });
      options.setFeedback(result.message);
      options.setLaunchPanel(null);
    } catch (error) {
      const message = (error as Error).message;
      options.postDebugLog("workspace.launch_panel.launch.error", {
        sessionId: session.sessionId,
        workspacePath,
        adapterId,
        message,
      });
      options.setLaunchPanel((current) => (current ? { ...current, busy: null, error: message } : current));
      options.setFeedback(`Launch failed: ${message}`);
    }
  }

  async function loadWorkspaceStatus(session: AgentSession) {
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      options.setWorkspacePanel((current) =>
        current ? { ...current, busy: null, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    options.setWorkspacePanel((current) => (current ? { ...current, busy: "status", error: null } : current));
    try {
      const status = await postBrokerJson<WorkspaceMaintenanceStatus>(BROKER_WORKSPACE_STATUS_URL, {
        workspacePath,
      });
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? {
              ...current,
              status,
              busy: null,
              error: null,
            }
          : current,
      );
      options.postDebugLog("workspace.maintenance.status.ok", {
        sessionId: session.sessionId,
        workspacePath,
        issueCount: status.issues.length,
      });
    } catch (error) {
      const rawMessage = (error as Error).message;
      const message = /update-obsidian-plugin.+not supported/iu.test(rawMessage)
        ? "AMO broker is still running an older version. Restart AMO, then try Update plugin again."
        : rawMessage;
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      options.postDebugLog("workspace.maintenance.status.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  async function cleanWorkspaceVaultFromPanel() {
    if (!options.workspacePanel) return;
    const session = options.workspacePanel.session;
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      options.setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    options.setCleanConfirm(null);
    options.setWorkspacePanel((current) => (current ? { ...current, busy: "clean", error: null } : current));
    options.setFeedback(`Cleaning AMO notes for ${projectName(workspacePath)}...`);
    try {
      const result = await postBrokerJson<WorkspaceCleanResult>(BROKER_WORKSPACE_CLEAN_VAULT_URL, {
        workspacePath,
      });
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? {
              ...current,
              status: result.after,
              busy: null,
              error: null,
            }
          : current,
      );
      options.setFeedback(workspaceCleanFeedback(result));
      options.postDebugLog("workspace.maintenance.clean.ok", {
        sessionId: session.sessionId,
        workspacePath,
        clearedSessions: result.clearedSessions,
      });
      void options.refreshSessions("workspace-clean");
    } catch (error) {
      const message = (error as Error).message;
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      options.setFeedback(`Clean failed: ${message}`);
      options.postDebugLog("workspace.maintenance.clean.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  async function updateWorkspaceObsidianPluginFromPanel() {
    if (!options.workspacePanel) return;
    const session = options.workspacePanel.session;
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      options.setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    options.setWorkspacePanel((current) => (current ? { ...current, busy: "plugin-update", error: null } : current));
    options.setFeedback(`Updating AMO Obsidian plugin for ${projectName(workspacePath)}...`);
    try {
      const result = await postBrokerJson<WorkspacePluginUpdateResult>(BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL, {
        workspacePath,
      });
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? {
              ...current,
              status: result.after,
              busy: null,
              error: null,
            }
          : current,
      );
      options.setFeedback(
        result.after.pluginHealth?.ok
          ? `AMO Obsidian plugin updated to ${result.after.pluginHealth.expectedVersion ?? "expected version"}.`
          : "AMO Obsidian plugin was updated, but the workspace still needs review.",
      );
      options.postDebugLog("workspace.maintenance.plugin_update.ok", {
        sessionId: session.sessionId,
        workspacePath,
        pluginHealth: result.after.pluginHealth,
      });
      void options.refreshSessions("workspace-plugin-update");
    } catch (error) {
      const message = (error as Error).message;
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      options.setFeedback(`Plugin update failed: ${message}`);
      options.postDebugLog("workspace.maintenance.plugin_update.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  function requestCleanWorkspaceVault() {
    if (!options.workspacePanel) return;
    const workspacePath = workspacePathForSession(options.workspacePanel.session);
    if (!workspacePath) {
      options.setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    options.setCleanConfirm({
      session: options.workspacePanel.session,
      workspacePath,
      replyNotes: options.workspacePanel.status?.counts.replyNotes ?? 0,
      promptNotes: options.workspacePanel.status?.counts.promptNotes ?? 0,
      canvasNodes: options.workspacePanel.status?.counts.canvasNodes ?? 0,
    });
  }

  async function openMaintenancePath(path: string | undefined, label: string) {
    if (!path) return;
    options.setWorkspacePanel((current) => (current ? { ...current, busy: "open", error: null } : current));
    try {
      const result = await invoke<OpenPathResult>("open_path", { path });
      options.setFeedback(result.ok ? `Opened ${label}.` : result.message);
      if (!result.ok) {
        options.setWorkspacePanel((current) => (current ? { ...current, error: result.message } : current));
      }
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Open ${label} failed: ${message}`);
      options.setWorkspacePanel((current) => (current ? { ...current, error: message } : current));
    } finally {
      options.setWorkspacePanel((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function saveWorkspacePanelTaskTitle(overrideTaskTitle?: string) {
    if (!options.workspacePanel) return;

    const sessionId = options.workspacePanel.session.sessionId;
    const nextTaskTitle = (overrideTaskTitle ?? options.workspacePanel.taskTitleDraft).trim();
    options.setWorkspacePanel((current) => (current ? { ...current, busy: "task-title", error: null } : current));
    options.setFeedback(nextTaskTitle ? `Saving task name: ${nextTaskTitle}` : "Clearing task name...");
    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionTaskTitleUrl(sessionId),
        { taskTitle: nextTaskTitle },
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === result.session.sessionId
          ? {
              ...current,
              session: result.session,
              taskTitleDraft: result.session.taskTitle ?? "",
              busy: null,
              error: null,
            }
          : current,
      );
      options.setFeedback(nextTaskTitle ? "Task name saved." : "Task name cleared.");
      options.postDebugLog("session.task_title.save.ok", {
        sessionId,
        hasTaskTitle: Boolean(nextTaskTitle),
      });
    } catch (error) {
      const message = (error as Error).message;
      options.setWorkspacePanel((current) =>
        current && current.session.sessionId === sessionId ? { ...current, busy: null, error: message } : current,
      );
      options.setFeedback(`Task name save failed: ${message}`);
      options.postDebugLog("session.task_title.save.error", {
        sessionId,
        message,
      });
    }
  }

  return {
    cleanWorkspaceVaultFromPanel,
    launchProjectCliFromPanel,
    loadWorkspaceStatus,
    openLaunchPanel,
    openMaintenancePath,
    openWorkspacePanel,
    requestCleanWorkspaceVault,
    saveWorkspacePanelTaskTitle,
    updateWorkspaceObsidianPluginFromPanel,
  };
}
