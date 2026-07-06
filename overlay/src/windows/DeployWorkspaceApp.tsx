import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, FolderOpen, FolderPlus, RefreshCcw, SquareTerminal, Trash2, X } from "lucide-react";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_WORKSPACE_CLEAN_VAULT_URL,
  BROKER_WORKSPACE_ENROLL_URL,
  BROKER_WORKSPACE_GIT_EXCLUDE_URL,
  BROKER_WORKSPACE_INSPECT_URL,
  BROKER_WORKSPACE_LAUNCH_URL,
  postBrokerJson,
} from "../api/brokerClient";
import { projectName, shortPathLabel } from "../domain/routingModel";
import {
  adapterContextLabel,
  adapterStateLabel,
  isDeployableWorkspaceAdapter,
  isWorkspaceAdapterDeployed,
  isWorkspaceAdapterInstalled,
  selectedWorkspaceAdapterIds,
  workspaceCleanFeedback,
  workspaceDeploymentStateLabel,
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
              <strong>Deploy Workspace</strong>
              <span>Project-local hooks and AMO vault</span>
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
          <section className="dialog-section deploy-workspace-section">
            <div className="dialog-section-heading">
              <strong>Workspace</strong>
              <span>{workspaceInspection ? projectName(workspaceInspection.workspacePath) : "Not checked"}</span>
            </div>
            <input
              className="deploy-path-input"
              type="text"
              spellCheck={false}
              value={workspacePath}
              placeholder="Paste or choose a workspace path"
              title={workspacePath || "No workspace selected"}
              disabled={deployBusy !== null || launchBusy !== null}
              onChange={(event) => updateWorkspacePathInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void inspectWorkspace();
                }
              }}
            />
            <div className="deploy-action-row">
              <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void chooseWorkspaceDirectory()}>
                Choose
              </button>
              <button
                type="button"
                title="Check folder before deploying; this does not write files."
                disabled={!workspacePath.trim() || deployBusy !== null || launchBusy !== null}
                onClick={() => void inspectWorkspace()}
              >
                {deployBusy === "inspect" ? "Checking" : "Check"}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!workspaceInspection || selectedDeployAdapters.length === 0 || deployBusy !== null || launchBusy !== null}
                onClick={() => void enrollWorkspace()}
              >
                {deployBusy === "enroll" ? "Deploying" : "Deploy Selected"}
              </button>
              <button
                type="button"
                className="danger-action"
                title="Clear generated session notes and reset the base canvas without removing hooks."
                disabled={!workspaceInspection?.existingEnrollment || deployBusy !== null || launchBusy !== null}
                onClick={() => void clearWorkspaceGenerated()}
              >
                <Trash2 size={12} aria-hidden="true" />
                <span>{deployBusy === "clean" ? "Clearing" : "Clear Generated"}</span>
              </button>
            </div>

            {workspaceInspection ? (
              <>
                <dl className="deploy-status-grid">
                  <div>
                    <dt>Path</dt>
                    <dd title={workspaceInspection.workspacePath}>{shortPathLabel(workspaceInspection.workspacePath)}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{workspaceDeploymentStateLabel(workspaceInspection)}</dd>
                  </div>
                  <div>
                    <dt>Selected</dt>
                    <dd>{selectedDeployAdapters.length}</dd>
                  </div>
                </dl>
                <div className="deploy-state-note">{workspaceDeploymentSummary(workspaceInspection)}</div>
              </>
            ) : (
              <div className="deploy-placeholder">Check a workspace to review deployment status.</div>
            )}

            <div className="deploy-subsection">
              <div className="dialog-section-heading">
                <strong>Git exclude</strong>
                <span>{gitExcludeStatus ? gitExcludeStatus.status : "Optional"}</span>
              </div>
              <input
                className="deploy-path-input"
                type="text"
                spellCheck={false}
                value={gitRootPath}
                placeholder="Git repository root, optional"
                title={gitRootPath || "No Git root selected"}
                disabled={gitExcludeBlocked}
                onChange={(event) => updateGitRootPathInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void applyGitExclude();
                  }
                }}
              />
              <div className="deploy-action-row">
                <button type="button" disabled={gitExcludeBlocked} onClick={() => void chooseGitDirectory()}>
                  Choose Git
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!workspacePath.trim() || gitExcludeBlocked}
                  onClick={() => void applyGitExclude()}
                >
                  {gitExcludeBusy ? "Adding" : "Add exclude"}
                </button>
              </div>
              <label className="deploy-option-row">
                <input
                  type="checkbox"
                  checked={includeClaudeSettingsExclude}
                  disabled={gitExcludeBlocked}
                  onChange={(event) => updateClaudeSettingsExclude(event.currentTarget.checked)}
                />
                <span>Also exclude `.claude\\settings.local.json`</span>
              </label>
              {gitExcludeStatus ? (
                <>
                  <div className={`deploy-git-exclude-note status-${gitExcludeStatus.status}`}>
                    <span title={gitExcludeStatus.excludeFilePath || gitExcludeStatus.message}>{gitExcludeStatus.message}</span>
                    {gitExcludeStatus.missingEntries.length > 0 ? (
                      <small>{gitExcludeStatus.missingEntries.map((entry) => entry.pattern).join(", ")}</small>
                    ) : gitExcludeStatus.excludeFilePath ? (
                      <small title={gitExcludeStatus.excludeFilePath}>{shortPathLabel(gitExcludeStatus.excludeFilePath)}</small>
                    ) : null}
                  </div>
                  {gitExcludeStatus.entries.length > 0 ? (
                    <ul className="deploy-git-exclude-list" aria-label="Git exclude pattern status">
                      {gitExcludeStatus.entries.map((entry) => {
                        const missing = gitExcludeMissingPatterns.has(entry.pattern);
                        const tracked = gitExcludeTrackedPatterns.has(entry.pattern);
                        const itemState = missing ? "missing" : tracked ? "tracked" : "covered";
                        return (
                          <li className={`is-${itemState}`} key={entry.pattern}>
                            <em>{itemState}</em>
                            <span title={tracked ? "This path is already tracked by Git, so exclude cannot hide it." : entry.reason || entry.pattern}>
                              {entry.pattern}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </>
              ) : (
                <div className="deploy-git-exclude-note">
                  <span>Exclude options changed. Click Add exclude to check and write missing patterns.</span>
                </div>
              )}
            </div>
          </section>

          <section className="dialog-section deploy-adapters-section">
            <div className="dialog-section-heading">
              <strong>Adapters</strong>
              <span>{workspaceInspection ? `${workspaceInspection.supportedAdapters.length} available targets` : "Awaiting check"}</span>
            </div>
            {workspaceInspection ? (
              <div className="deploy-adapter-list">
                {workspaceInspection.supportedAdapters.map((adapter) => {
                  const selectable = isDeployableWorkspaceAdapter(adapter);
                  const selected = selectedDeployAdapters.includes(adapter.id);
                  const installed = isWorkspaceAdapterInstalled(adapter);
                  const stateLabel = adapterStateLabel(adapter);
                  const contextLabel = adapterContextLabel(adapter);
                  return (
                    <article
                      className={`deploy-adapter-card status-${adapter.status} state-${stateLabel} ${
                        selected ? "is-selected" : ""
                      }`}
                      key={adapter.id}
                      title={adapter.reason}
                    >
                      <label className="deploy-adapter-select" title={selectable ? "Include in Deploy Selected" : "Adapter unavailable"}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!selectable || deployBusy !== null}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedDeployAdapters((current) =>
                              checked ? Array.from(new Set([...current, adapter.id])) : current.filter((id) => id !== adapter.id),
                            );
                          }}
                        />
                      </label>
                      <span className="deploy-adapter-copy">
                        <strong>{adapter.label}</strong>
                        <span>{adapter.reason}</span>
                      </span>
                      <span className="deploy-adapter-badges">
                        <em>{stateLabel}</em>
                        {contextLabel ? <small>{contextLabel}</small> : null}
                      </span>
                      <span className="deploy-adapter-actions">
                        {installed ? (
                          <>
                            <button
                              type="button"
                              disabled={deployBusy !== null || launchBusy !== null}
                              onClick={() => void launchWorkspace(adapter.id)}
                            >
                              <SquareTerminal size={12} aria-hidden="true" />
                              <span>{launchBusy === adapter.id ? "Starting" : "Run"}</span>
                            </button>
                            {adapter.id === "codex-cli" ? (
                              <button
                                type="button"
                                disabled={deployBusy !== null || launchBusy !== null}
                                onClick={() => void launchWorkspace("codex-app")}
                              >
                                <Bot size={12} aria-hidden="true" />
                                <span>{launchBusy === "codex-app" ? "Opening" : "App"}</span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={!selectable || deployBusy !== null || launchBusy !== null}
                              onClick={() => void enrollWorkspace([adapter.id])}
                            >
                              <RefreshCcw size={12} aria-hidden="true" />
                              <span>Update</span>
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="primary"
                            disabled={!selectable || deployBusy !== null || launchBusy !== null}
                            onClick={() => void enrollWorkspace([adapter.id])}
                          >
                            <span>{deployBusy === "enroll" ? "Deploying" : "Deploy"}</span>
                          </button>
                        )}
                      </span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="deploy-placeholder">Adapter details appear after Check.</div>
            )}
          </section>
        </div>

        <footer className="app-dialog-footer">
          {workspaceEnrollment ? (
            <div className="deploy-result" title={workspaceEnrollment.vaultRoot}>
              <div className="deploy-result-copy">
                <div className="deploy-result-summary">
                  <strong>{workspaceEnrollment.installedAdapters.join(", ")}</strong>
                  <span>{workspaceEnrollment.installedFiles.length} files</span>
                  <span>{workspaceEnrollment.mergedFiles.length} merged</span>
                </div>
                <span className="deploy-result-feedback" title={feedback}>
                  {feedback}
                </span>
              </div>
              <div className="deploy-launch-actions" aria-label="Launch workspace tools">
                {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
                  <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void launchWorkspace("codex-cli")}>
                    <SquareTerminal size={12} aria-hidden="true" />
                    <span>{launchBusy === "codex-cli" ? "Starting" : "Run Codex"}</span>
                  </button>
                ) : null}
                {workspaceEnrollment.installedAdapters.includes("claude-cli") ? (
                  <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void launchWorkspace("claude-cli")}>
                    <SquareTerminal size={12} aria-hidden="true" />
                    <span>{launchBusy === "claude-cli" ? "Starting" : "Run Claude"}</span>
                  </button>
                ) : null}
                {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
                  <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void launchWorkspace("codex-app")}>
                    <Bot size={12} aria-hidden="true" />
                    <span>{launchBusy === "codex-app" ? "Opening" : "Open App"}</span>
                  </button>
                ) : null}
                <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void openDeploymentPath(workspaceEnrollment.workspacePath, "workspace")}>
                  <FolderOpen size={12} aria-hidden="true" />
                  <span>Project</span>
                </button>
                <button type="button" disabled={deployBusy !== null || launchBusy !== null} onClick={() => void openDeploymentPath(workspaceEnrollment.vaultRoot, "vault")}>
                  <FolderOpen size={12} aria-hidden="true" />
                  <span>Vault</span>
                </button>
              </div>
            </div>
          ) : (
            <span title={feedback}>{feedback}</span>
          )}
        </footer>
      </section>
    </main>
  );
}
