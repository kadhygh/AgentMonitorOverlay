import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, Plus, Trash2, X } from "lucide-react";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_WORKSPACE_CLEAN_VAULT_URL,
  BROKER_WORKSPACE_ENROLL_URL,
  BROKER_WORKSPACE_GIT_EXCLUDE_URL,
  BROKER_WORKSPACE_INSPECT_URL,
  BROKER_WORKSPACE_LAUNCH_URL,
  BROKER_WORKSPACE_FORGET_URL,
  BROKER_WORKSPACES_URL,
  getBrokerJson,
  postBrokerJson,
} from "../api/brokerClient";
import {
  DeployAdaptersSection,
  DeployResultFooter,
  DeployWorkspaceSection,
} from "../components/DeployWorkspaceSections";
import { projectName } from "../domain/routingModel";
import {
  isDeployableWorkspaceAdapter,
  isWorkspaceAdapterDeployed,
  selectedWorkspaceAdapterIds,
  workspaceCleanFeedback,
  workspaceDeploymentSummary,
  workspaceGeneratedNoteCount,
} from "../domain/workspaceModel";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import type {
  FolderPickResult,
  OpenPathResult,
  WorkspaceCleanResult,
  WorkspaceEnrollment,
  WorkspaceGitExcludeResult,
  WorkspaceInspection,
  WorkspaceLaunchResult,
  WorkspaceRegistryEntry,
  WorkspaceRegistryResult,
} from "../types";
import {
  closeUtilityWindow,
  runWithNativeDialogLayer,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
} from "./utilityWindow";

const OBSIDIAN_PLUGIN_RELOAD_HINT = "Restart Obsidian or reload the AMO plugin if this vault is already open.";

export function DeployWorkspaceApp() {
  useUtilityWindowLifecycle("deploy");
  useAmoThemeRuntime();

  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceInspection, setWorkspaceInspection] = useState<WorkspaceInspection | null>(null);
  const [workspaceEnrollment, setWorkspaceEnrollment] = useState<WorkspaceEnrollment | null>(null);
  const [selectedDeployAdapters, setSelectedDeployAdapters] = useState<string[]>([]);
  const [deployBusy, setDeployBusy] = useState<"inspect" | "enroll" | "clean" | null>(null);
  const [gitExcludeBusy, setGitExcludeBusy] = useState(false);
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const [gitRootPath, setGitRootPath] = useState("");
  const [gitExcludeResult, setGitExcludeResult] = useState<WorkspaceGitExcludeResult | null>(null);
  const [includeClaudeSettingsExclude, setIncludeClaudeSettingsExclude] = useState(false);
  const includeClaudeSettingsExcludeRef = useRef(false);
  const [feedback, setFeedback] = useState("Choose or paste a workspace path.");
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<WorkspaceRegistryEntry[]>([]);
  const [registryBusy, setRegistryBusy] = useState(false);

  useEffect(() => {
    void loadWorkspaceRegistry();
  }, []);

  async function loadWorkspaceRegistry() {
    setRegistryBusy(true);
    try {
      const result = await getBrokerJson<WorkspaceRegistryResult>(BROKER_WORKSPACES_URL);
      setRegisteredWorkspaces(result.workspaces);
    } catch (error) {
      setFeedback(`Workspace list failed: ${(error as Error).message}`);
    } finally {
      setRegistryBusy(false);
    }
  }

  async function postUtilityDebugLog(event: string, data?: unknown) {
    try {
      await postBrokerJson<{ ok: boolean; count: number }>(BROKER_DEBUG_LOGS_URL, {
        source: "deploy-window",
        event,
        data: data ?? {},
      });
    } catch {
      // Debug logging should never block deployment actions.
    }
  }

  async function inspectWorkspace(pathOverride?: string) {
    const targetPath = (pathOverride ?? workspacePath).trim();
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    setDeployBusy("inspect");
    setWorkspaceEnrollment(null);
    setFeedback("Checking workspace...");

    try {
      const result = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath: targetPath,
        includeClaudeSettingsLocal: includeClaudeSettingsExcludeRef.current,
      });
      void postUtilityDebugLog("workspace.inspect.ok", {
        workspacePath: result.workspacePath,
        projectName: result.projectName,
        adapters: result.supportedAdapters.map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
          deploymentStatus: adapter.deploymentStatus,
          workspaceState: adapter.workspaceState,
          deployable: adapter.deployable,
          recommended: adapter.recommended,
        })),
      });
      setWorkspaceInspection(result);
      setWorkspacePath(result.workspacePath);
      setGitRootPath(result.gitExclude?.gitRootPath || "");
      setGitExcludeResult(null);
      const selectedAdapters = selectedWorkspaceAdapterIds(result);
      setSelectedDeployAdapters(selectedAdapters);
      setFeedback(`${result.projectName}: ${workspaceDeploymentSummary(result)}`);
      if (result.existingEnrollment) void loadWorkspaceRegistry();
    } catch (error) {
      void postUtilityDebugLog("workspace.inspect.error", {
        workspacePath: targetPath,
        message: (error as Error).message,
      });
      setWorkspaceInspection(null);
      setFeedback(`Check failed: ${(error as Error).message}`);
    } finally {
      setDeployBusy(null);
    }
  }

  async function chooseWorkspaceDirectory() {
    setFeedback("Choose a workspace folder...");

    try {
      const result = await runWithNativeDialogLayer(() => invoke<FolderPickResult>("select_workspace_directory"));
      if (!result.ok || !result.path) {
        setFeedback(result.message);
        return;
      }

      setWorkspacePath(result.path);
      setWorkspaceInspection(null);
      setWorkspaceEnrollment(null);
      setGitRootPath("");
      setGitExcludeResult(null);
      includeClaudeSettingsExcludeRef.current = false;
      setIncludeClaudeSettingsExclude(false);
      setSelectedDeployAdapters([]);
      await inspectWorkspace(result.path);
    } catch (error) {
      setFeedback(`Folder selection failed: ${(error as Error).message}`);
    }
  }

  function updateWorkspacePathInput(value: string) {
    setWorkspacePath(value);
    if (workspaceInspection && value.trim() !== workspaceInspection.workspacePath) {
      setWorkspaceInspection(null);
      setWorkspaceEnrollment(null);
      setGitExcludeResult(null);
      setSelectedDeployAdapters([]);
    }
  }

  function updateGitRootPathInput(value: string) {
    setGitRootPath(value);
    setGitExcludeResult(null);
  }

  function updateClaudeSettingsExclude(checked: boolean) {
    includeClaudeSettingsExcludeRef.current = checked;
    setIncludeClaudeSettingsExclude(checked);
    setGitExcludeResult(null);
  }

  async function chooseGitDirectory() {
    setFeedback("Choose a Git repository folder...");

    try {
      const result = await runWithNativeDialogLayer(() => invoke<FolderPickResult>("select_workspace_directory"));
      if (!result.ok || !result.path) {
        setFeedback(result.message);
        return;
      }

      setGitRootPath(result.path);
      setGitExcludeResult(null);
      setFeedback("Git folder selected. Click Add exclude to write local rules.");
    } catch (error) {
      setFeedback(`Git folder selection failed: ${(error as Error).message}`);
    }
  }

  async function applyGitExclude() {
    const targetPath = workspaceInspection?.workspacePath ?? workspacePath.trim();
    const targetGitRoot = gitRootPath.trim();
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    setGitExcludeBusy(true);
    setFeedback("Updating Git exclude...");

    try {
      const includeClaudeSettingsLocal = includeClaudeSettingsExcludeRef.current;
      const result = await postBrokerJson<WorkspaceGitExcludeResult>(BROKER_WORKSPACE_GIT_EXCLUDE_URL, {
        workspacePath: targetPath,
        gitRootPath: targetGitRoot || undefined,
        includeClaudeSettingsLocal,
      });
      void postUtilityDebugLog("workspace.git_exclude.ok", {
        workspacePath: result.workspacePath,
        gitRootPath: result.gitRootPath,
        excludeFilePath: result.excludeFilePath,
        addedEntries: result.addedEntries.map((entry) => entry.pattern),
        includeClaudeSettingsLocal,
      });
      setGitRootPath(result.gitRootPath);
      setGitExcludeResult(result);
      const refreshed = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath: result.workspacePath,
        gitRootPath: result.gitRootPath,
        includeClaudeSettingsLocal,
      });
      setWorkspaceInspection(refreshed);
      const addedPatterns = result.addedEntries.map((entry) => entry.pattern).join(", ");
      const trackedCount = result.status.trackedEntries.length;
      setFeedback(
        result.changed
          ? `Added ${result.addedEntries.length} Git exclude pattern(s): ${addedPatterns}`
          : trackedCount > 0
          ? `Git exclude covers selected patterns, but ${trackedCount} tracked file(s) still appear in Git.`
          : includeClaudeSettingsLocal
          ? "Git exclude already covers selected AMO and Claude local artifacts."
          : "Git exclude already covers selected AMO local artifacts.",
      );
    } catch (error) {
      void postUtilityDebugLog("workspace.git_exclude.error", {
        workspacePath: targetPath,
        gitRootPath: targetGitRoot,
        includeClaudeSettingsLocal: includeClaudeSettingsExcludeRef.current,
        message: (error as Error).message,
      });
      setFeedback(`Git exclude failed: ${(error as Error).message}`);
    } finally {
      setGitExcludeBusy(false);
    }
  }

  async function enrollWorkspace(adapterIds?: string[]) {
    const targetPath = workspaceInspection?.workspacePath ?? workspacePath.trim();
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    setDeployBusy("enroll");
    setFeedback("Deploying workspace adapter...");

    try {
      const adapters =
        adapterIds && adapterIds.length > 0
          ? adapterIds
          : selectedDeployAdapters.length > 0
          ? selectedDeployAdapters
          : (workspaceInspection?.supportedAdapters || [])
              .filter((adapter) => isDeployableWorkspaceAdapter(adapter) && !isWorkspaceAdapterDeployed(adapter))
              .map((adapter) => adapter.id);
      if (adapters.length === 0) {
        setFeedback("No deployable adapter selected.");
        return;
      }

      const result = await postBrokerJson<WorkspaceEnrollment>(BROKER_WORKSPACE_ENROLL_URL, {
        workspacePath: targetPath,
        adapters,
      });
      void postUtilityDebugLog("workspace.enroll.ok", {
        workspacePath: result.workspacePath,
        vaultRoot: result.vaultRoot,
        installedAdapters: result.installedAdapters,
      });
      setWorkspaceEnrollment(result);
      const refreshed = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath: result.workspacePath,
        gitRootPath: gitRootPath.trim() || undefined,
        includeClaudeSettingsLocal: includeClaudeSettingsExcludeRef.current,
      });
      setWorkspaceInspection(refreshed);
      setGitRootPath(refreshed.gitExclude?.gitRootPath || gitRootPath);
      setGitExcludeResult(null);
      setSelectedDeployAdapters(selectedWorkspaceAdapterIds(refreshed));
      setFeedback(`Deployed ${result.installedAdapters.join(", ")} for ${projectName(result.workspacePath)}. ${OBSIDIAN_PLUGIN_RELOAD_HINT}`);
      void loadWorkspaceRegistry();
    } catch (error) {
      void postUtilityDebugLog("workspace.enroll.error", {
        workspacePath: targetPath,
        message: (error as Error).message,
      });
      setFeedback(`Deploy failed: ${(error as Error).message}`);
    } finally {
      setDeployBusy(null);
    }
  }

  async function clearWorkspaceGenerated() {
    const targetPath = workspaceInspection?.workspacePath ?? (workspacePath.trim() || workspaceEnrollment?.workspacePath);
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    if (!workspaceInspection?.existingEnrollment) {
      setFeedback("Check an enrolled AMO workspace before clearing generated content.");
      return;
    }

    const confirmed = window.confirm(
      `Clear generated AMO notes and reset the base canvas for ${projectName(targetPath)}?\n\nHooks, deployment metadata, and work canvas folders will be kept.`,
    );
    if (!confirmed) return;

    setDeployBusy("clean");
    setFeedback(`Clearing generated AMO content for ${projectName(targetPath)}...`);

    try {
      const result = await postBrokerJson<WorkspaceCleanResult>(BROKER_WORKSPACE_CLEAN_VAULT_URL, {
        workspacePath: targetPath,
      });
      void postUtilityDebugLog("workspace.deploy.clean.ok", {
        workspacePath: result.workspacePath,
        generatedNotes: workspaceGeneratedNoteCount(result.before),
        canvasNodes: result.before.counts.canvasNodes,
        clearedSessions: result.clearedSessions,
      });
      const refreshed = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath: result.workspacePath,
        gitRootPath: gitRootPath.trim() || undefined,
        includeClaudeSettingsLocal: includeClaudeSettingsExcludeRef.current,
      });
      setWorkspaceInspection(refreshed);
      setWorkspacePath(refreshed.workspacePath);
      setSelectedDeployAdapters(selectedWorkspaceAdapterIds(refreshed));
      setGitRootPath(refreshed.gitExclude?.gitRootPath || gitRootPath);
      setGitExcludeResult(null);
      setFeedback(workspaceCleanFeedback(result));
    } catch (error) {
      void postUtilityDebugLog("workspace.deploy.clean.error", {
        workspacePath: targetPath,
        message: (error as Error).message,
      });
      setFeedback(`Clear failed: ${(error as Error).message}`);
    } finally {
      setDeployBusy(null);
    }
  }

  async function launchWorkspace(adapterId: string) {
    const targetPath = workspaceInspection?.workspacePath ?? (workspacePath.trim() || workspaceEnrollment?.workspacePath);
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    setLaunchBusy(adapterId);
    const label =
      adapterId === "codex-cli" ? "Codex CLI" : adapterId === "claude-cli" ? "Claude CLI" : "Codex App";
    setFeedback(`Launching ${label}...`);

    try {
      const result = await postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, {
        workspacePath: targetPath,
        adapterId,
      });
      void postUtilityDebugLog("workspace.launch.ok", {
        workspacePath: result.workspacePath,
        adapterId: result.adapterId,
        pid: result.pid ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      void postUtilityDebugLog("workspace.launch.error", {
        workspacePath: targetPath,
        adapterId,
        message: (error as Error).message,
      });
      setFeedback(`Launch failed: ${(error as Error).message}`);
    } finally {
      setLaunchBusy(null);
    }
  }

  async function selectRegisteredWorkspace(workspace: WorkspaceRegistryEntry) {
    setWorkspacePath(workspace.workspacePath);
    setWorkspaceInspection(null);
    setWorkspaceEnrollment(null);
    setSelectedDeployAdapters([]);
    if (!workspace.available) {
      setFeedback(`${workspace.projectName} is unavailable. Locate it with Choose or forget this registry entry.`);
      return;
    }
    await inspectWorkspace(workspace.workspacePath);
  }

  async function forgetRegisteredWorkspace(workspace: WorkspaceRegistryEntry) {
    try {
      await postBrokerJson<{ ok: boolean }>(BROKER_WORKSPACE_FORGET_URL, { workspaceId: workspace.workspaceId });
      if (workspacePath === workspace.workspacePath) {
        setWorkspacePath("");
        setWorkspaceInspection(null);
        setWorkspaceEnrollment(null);
      }
      await loadWorkspaceRegistry();
      setFeedback(`Forgot ${workspace.projectName}. Project files were not changed.`);
    } catch (error) {
      setFeedback(`Forget failed: ${(error as Error).message}`);
    }
  }

  function prepareNewWorkspace() {
    setWorkspacePath("");
    setWorkspaceInspection(null);
    setWorkspaceEnrollment(null);
    setSelectedDeployAdapters([]);
    setGitRootPath("");
    setFeedback("Choose or paste a workspace path.");
  }

  async function openDeploymentPath(path: string | undefined, label: string) {
    if (!path) return;
    try {
      const result = await invoke<OpenPathResult>("open_path", { path });
      setFeedback(result.ok ? `Opened ${label}.` : result.message);
    } catch (error) {
      setFeedback(`Open ${label} failed: ${(error as Error).message}`);
    }
  }

  const rawGitExcludeStatus = gitExcludeResult?.status ?? workspaceInspection?.gitExclude ?? null;
  const gitExcludeStatus =
    rawGitExcludeStatus && Boolean(rawGitExcludeStatus.includeClaudeSettingsLocal) === includeClaudeSettingsExclude
      ? rawGitExcludeStatus
      : null;
  const gitExcludeMissingPatterns = new Set(gitExcludeStatus?.missingEntries.map((entry) => entry.pattern) ?? []);
  const gitExcludeTrackedPatterns = new Set(gitExcludeStatus?.trackedEntries.map((entry) => entry.pattern) ?? []);
  const gitExcludeBlocked = deployBusy !== null || launchBusy !== null || gitExcludeBusy;

  return (
    <main className="utility-window-shell deploy-window-shell">
      <section className="app-dialog deploy-panel" role="dialog" aria-label="Workspace deployment">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <FolderPlus size={16} aria-hidden="true" />
            <div>
              <strong>Workspace Center</strong>
              <span>Projects, adapters and managed launches</span>
            </div>
          </div>
          <button
            type="button"
            className="candidate-close"
            title="Close deploy"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void closeUtilityWindow("deploy");
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <div className="deploy-dialog-body">
          <aside className="workspace-registry" aria-label="Registered workspaces">
            <div className="workspace-registry-heading">
              <div>
                <strong>Workspaces</strong>
                <span>{registryBusy ? "Loading" : `${registeredWorkspaces.length} registered`}</span>
              </div>
              <button type="button" title="Add workspace" onClick={prepareNewWorkspace}>
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="workspace-registry-list">
              {registeredWorkspaces.length === 0 ? (
                <p>No deployed workspaces yet.</p>
              ) : registeredWorkspaces.map((workspace) => (
                <div
                  className={`workspace-registry-item${workspace.workspacePath === workspacePath ? " selected" : ""}`}
                  key={workspace.workspaceId}
                >
                  <button type="button" className="workspace-registry-select" onClick={() => void selectRegisteredWorkspace(workspace)}>
                    <span className={`workspace-status-dot ${workspace.status}`} aria-hidden="true" />
                    <span>
                      <strong>{workspace.projectName}</strong>
                      <small>{workspace.adapterIds.join(" + ") || "No adapters"}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="workspace-registry-forget"
                    title="Forget workspace"
                    onClick={() => void forgetRegisteredWorkspace(workspace)}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </aside>
          <DeployWorkspaceSection
            workspacePath={workspacePath}
            workspaceInspection={workspaceInspection}
            selectedDeployAdapters={selectedDeployAdapters}
            deployBusy={deployBusy}
            launchBusy={launchBusy}
            gitRootPath={gitRootPath}
            gitExcludeStatus={gitExcludeStatus}
            gitExcludeMissingPatterns={gitExcludeMissingPatterns}
            gitExcludeTrackedPatterns={gitExcludeTrackedPatterns}
            gitExcludeBlocked={gitExcludeBlocked}
            gitExcludeBusy={gitExcludeBusy}
            includeClaudeSettingsExclude={includeClaudeSettingsExclude}
            onWorkspacePathChange={updateWorkspacePathInput}
            onInspectWorkspace={() => void inspectWorkspace()}
            onChooseWorkspace={() => void chooseWorkspaceDirectory()}
            onDeploySelected={() => void enrollWorkspace()}
            onClearGenerated={() => void clearWorkspaceGenerated()}
            onGitRootPathChange={updateGitRootPathInput}
            onApplyGitExclude={() => void applyGitExclude()}
            onChooseGit={() => void chooseGitDirectory()}
            onClaudeSettingsExcludeChange={updateClaudeSettingsExclude}
          />
          <DeployAdaptersSection
            workspaceInspection={workspaceInspection}
            selectedDeployAdapters={selectedDeployAdapters}
            deployBusy={deployBusy}
            launchBusy={launchBusy}
            onAdapterSelectedChange={(adapterId, selected) => {
              setSelectedDeployAdapters((current) =>
                selected ? Array.from(new Set([...current, adapterId])) : current.filter((id) => id !== adapterId),
              );
            }}
            onDeployAdapter={(adapterId) => void enrollWorkspace([adapterId])}
            onLaunchWorkspace={(adapterId) => void launchWorkspace(adapterId)}
          />
        </div>

        <footer className="app-dialog-footer">
          <DeployResultFooter
            workspaceEnrollment={workspaceEnrollment}
            feedback={feedback}
            deployBusy={deployBusy}
            launchBusy={launchBusy}
            onLaunchWorkspace={(adapterId) => void launchWorkspace(adapterId)}
            onOpenDeploymentPath={(path, label) => void openDeploymentPath(path, label)}
          />
        </footer>
      </section>
    </main>
  );
}
