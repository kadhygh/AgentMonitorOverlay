import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpen, Check, Download, Folder, FolderOpen, Pencil, Plus, RefreshCw, X } from "lucide-react";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_WORKSPACE_CLEAN_VAULT_URL,
  BROKER_WORKSPACE_DOCUMENT_MAPPINGS_URL,
  BROKER_WORKSPACE_ENROLL_URL,
  BROKER_WORKSPACE_GIT_EXCLUDE_URL,
  BROKER_WORKSPACE_INSPECT_URL,
  BROKER_WORKSPACE_LABEL_URL,
  BROKER_WORKSPACE_FORGET_URL,
  BROKER_WORKSPACES_URL,
  getBrokerJson,
  postBrokerJson,
} from "../api/brokerClient";
import type { ManagedLaunchSelection } from "../components/LaunchPanel";
import { WorkspaceLaunchForm } from "../components/WorkspaceLaunchForm";
import { openModelSettingsWindow } from "../hooks/useMainUtilityWindows";
import {
  DocumentMappingsSection,
  GitExcludeStatusView,
} from "../components/DeployWorkspaceSections";
import { projectName } from "../domain/routingModel";
import {
  isDeployableWorkspaceAdapter,
  isWorkspaceAdapterDeployed,
  selectedWorkspaceAdapterIds,
  workspaceCleanFeedback,
  workspaceDeploymentSummary,
  workspaceGeneratedNoteCount,
  adapterContextLabel,
} from "../domain/workspaceModel";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import { launchWorkspaceTool } from "../api/workspaceLaunch";
import type {
  FolderPickResult,
  OpenPathResult,
  WorkspaceCleanResult,
  WorkspaceDocumentMappingEntry,
  WorkspaceDocumentMappingResult,
  WorkspaceEnrollment,
  WorkspaceGitExcludeResult,
  WorkspaceInspection,
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

  const [workspacePath, setWorkspacePath] = useState(() => {
    try { return localStorage.getItem("amo.workspace.requestedPath") || localStorage.getItem("amo.cli.lastWorkspacePath") || ""; } catch { return ""; }
  });
  const [workspaceInspection, setWorkspaceInspection] = useState<WorkspaceInspection | null>(null);
  const [workspaceEnrollment, setWorkspaceEnrollment] = useState<WorkspaceEnrollment | null>(null);
  const [selectedDeployAdapters, setSelectedDeployAdapters] = useState<string[]>([]);
  const [deployBusy, setDeployBusy] = useState<"inspect" | "enroll" | "clean" | null>(null);
  const [gitExcludeBusy, setGitExcludeBusy] = useState(false);
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"launch" | "deploy" | "settings">("launch");
  const [editingPath, setEditingPath] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<"clean" | "forget" | null>(null);
  const [gitRootPath, setGitRootPath] = useState("");
  const [gitExcludeResult, setGitExcludeResult] = useState<WorkspaceGitExcludeResult | null>(null);
  const [includeClaudeSettingsExclude, setIncludeClaudeSettingsExclude] = useState(false);
  const includeClaudeSettingsExcludeRef = useRef(false);
  const [documentMappingPath, setDocumentMappingPath] = useState("");
  const [documentMappingBusy, setDocumentMappingBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("Choose or paste a workspace path.");
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<WorkspaceRegistryEntry[]>([]);
  const [registryBusy, setRegistryBusy] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabelDraft, setWorkspaceLabelDraft] = useState("");

  useEffect(() => {
    try {
      if (localStorage.getItem("amo.workspace.requestedPath")) {
        localStorage.removeItem("amo.workspace.requestedPath");
        setActiveTab("deploy");
      }
    } catch { /* Optional navigation request. */ }
    void loadWorkspaceRegistry();
    if (workspacePath.trim()) void inspectWorkspace();
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
      setEditingPath(false);
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
      setEditingPath(false);
      setWorkspaceInspection(null);
      setWorkspaceEnrollment(null);
      setGitRootPath("");
      setGitExcludeResult(null);
      includeClaudeSettingsExcludeRef.current = false;
      setIncludeClaudeSettingsExclude(false);
      setSelectedDeployAdapters([]);
      setDocumentMappingPath("");
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
      setDocumentMappingPath("");
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

  async function chooseDocumentMappingDirectory() {
    setFeedback("Choose a project document folder...");

    try {
      const result = await runWithNativeDialogLayer(() => invoke<FolderPickResult>("select_workspace_directory"));
      if (!result.ok || !result.path) {
        setFeedback(result.message);
        return;
      }

      setDocumentMappingPath(result.path);
      setFeedback("Document folder selected. Click Deploy mapping to expose it inside the AMO vault.");
    } catch (error) {
      setFeedback(`Document folder selection failed: ${(error as Error).message}`);
    }
  }

  async function deployDocumentMapping(sourcePath?: string) {
    const targetWorkspace = workspaceInspection?.workspacePath ?? workspacePath.trim();
    const targetSource = (sourcePath ?? documentMappingPath).trim();
    if (!targetWorkspace || !targetSource) {
      setFeedback("Workspace and project document folder are required.");
      return;
    }
    if (!workspaceInspection?.existingEnrollment) {
      setFeedback("Deploy this workspace before adding project document mappings.");
      return;
    }

    const busyKey = sourcePath ? targetSource : "add";
    setDocumentMappingBusy(busyKey);
    setFeedback("Deploying project document mapping...");
    try {
      const result = await postBrokerJson<WorkspaceDocumentMappingResult>(BROKER_WORKSPACE_DOCUMENT_MAPPINGS_URL, {
        workspacePath: targetWorkspace,
        sourcePath: targetSource,
        action: "add",
      });
      setWorkspaceInspection((current) =>
        current ? { ...current, documentMappings: result.documentMappings } : current,
      );
      setDocumentMappingPath("");
      void postUtilityDebugLog("workspace.document_mapping.add.ok", {
        workspacePath: result.workspacePath,
        sourcePath: targetSource,
        projectRoot: result.documentMappings.projectRoot,
        changed: result.changed,
      });
      setFeedback(
        result.changed
          ? `Project documents mapped into ${result.documentMappings.projectRootRelativePath}.`
          : "Project document mapping is already active.",
      );
    } catch (error) {
      void postUtilityDebugLog("workspace.document_mapping.add.error", {
        workspacePath: targetWorkspace,
        sourcePath: targetSource,
        message: (error as Error).message,
      });
      setFeedback(`Document mapping failed: ${(error as Error).message}`);
    } finally {
      setDocumentMappingBusy(null);
    }
  }

  async function removeDocumentMapping(entry: WorkspaceDocumentMappingEntry) {
    const targetWorkspace = workspaceInspection?.workspacePath ?? workspacePath.trim();
    if (!targetWorkspace) return;

    setDocumentMappingBusy(entry.sourcePath);
    setFeedback(`Removing ${entry.label} mapping...`);
    try {
      const result = await postBrokerJson<WorkspaceDocumentMappingResult>(BROKER_WORKSPACE_DOCUMENT_MAPPINGS_URL, {
        workspacePath: targetWorkspace,
        sourcePath: entry.sourceRelativePath,
        action: "remove",
      });
      setWorkspaceInspection((current) =>
        current ? { ...current, documentMappings: result.documentMappings } : current,
      );
      void postUtilityDebugLog("workspace.document_mapping.remove.ok", {
        workspacePath: result.workspacePath,
        sourcePath: entry.sourcePath,
      });
      setFeedback(`Removed ${entry.label} mapping. Source files were not changed.`);
    } catch (error) {
      void postUtilityDebugLog("workspace.document_mapping.remove.error", {
        workspacePath: targetWorkspace,
        sourcePath: entry.sourcePath,
        message: (error as Error).message,
      });
      setFeedback(`Remove mapping failed: ${(error as Error).message}`);
    } finally {
      setDocumentMappingBusy(null);
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

    setMaintenance(null);
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

  async function launchWorkspace(selection: ManagedLaunchSelection, launchMode: "managed" | "cli-only") {
    const targetPath = workspacePath.trim();
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    const adapterId = selection.adapterId;
    setLaunchBusy(adapterId);
    const label = adapterId === "codex-cli"
      ? "Codex CLI"
      : adapterId === "claude-cli"
        ? "Claude CLI"
        : adapterId === "grok-build"
          ? "Grok Build"
          : "ChatGPT";
    setFeedback(`Launching ${label}...`);

    try {
      const result = await launchWorkspaceTool({
        workspacePath: targetPath, inspection: workspaceInspection, selection, launchMode,
      });
      void postUtilityDebugLog("workspace.launch.ok", {
        workspacePath: result.workspacePath,
        adapterId: result.adapterId,
        claudeProviderId: selection.claudeProvider?.presetId ?? null,
        codexProviderId: selection.codexProvider?.presetId ?? null,
        pid: result.pid ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      const message = (error as Error).message;
      void postUtilityDebugLog("workspace.launch.error", {
        workspacePath: targetPath,
        adapterId,
        claudeProviderId: selection.claudeProvider?.presetId ?? null,
        codexProviderId: selection.codexProvider?.presetId ?? null,
        message,
      });
      setFeedback(`Launch failed: ${message}`);
      throw error;
    } finally {
      setLaunchBusy(null);
    }
  }

  async function selectRegisteredWorkspace(workspace: WorkspaceRegistryEntry) {
    setMaintenance(null);
    setEditingWorkspaceId(null);
    setEditingPath(false);
    setGitRootPath("");
    setGitExcludeResult(null);
    setDocumentMappingPath("");
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
    setMaintenance(null);
    setRegistryBusy(true);
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
    } finally { setRegistryBusy(false); }
  }

  function beginWorkspaceLabelEdit(workspace: WorkspaceRegistryEntry) {
    setEditingWorkspaceId(workspace.workspaceId);
    setWorkspaceLabelDraft(workspace.workspaceLabel ?? "");
  }

  async function saveWorkspaceLabel(workspace: WorkspaceRegistryEntry) {
    setRegistryBusy(true);
    try {
      const result = await postBrokerJson<{ ok: boolean; workspace: WorkspaceRegistryEntry }>(
        BROKER_WORKSPACE_LABEL_URL,
        { workspaceId: workspace.workspaceId, workspaceLabel: workspaceLabelDraft },
      );
      setRegisteredWorkspaces((current) => current.map((entry) => (
        entry.workspaceId === result.workspace.workspaceId ? result.workspace : entry
      )));
      setEditingWorkspaceId(null);
      setFeedback(result.workspace.workspaceLabel
        ? `Workspace label saved as ${result.workspace.workspaceLabel}.`
        : `Automatic AMO task naming disabled for ${workspace.projectName}.`);
    } catch (error) {
      setFeedback(`Workspace label failed: ${(error as Error).message}`);
    } finally {
      setRegistryBusy(false);
    }
  }

  function prepareNewWorkspace() {
    setEditingPath(true);
    setActiveTab("launch");
    setMaintenance(null);
    setEditingWorkspaceId(null);
    setGitExcludeResult(null);
    setWorkspacePath("");
    setWorkspaceInspection(null);
    setWorkspaceEnrollment(null);
    setSelectedDeployAdapters([]);
    setGitRootPath("");
    setDocumentMappingPath("");
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
  const actionsBlocked = deployBusy !== null || launchBusy !== null || gitExcludeBusy || documentMappingBusy !== null || credentialBusy || registryBusy;
  const currentWorkspace = registeredWorkspaces.find(item => item.workspacePath === workspacePath);
  const vaultPath = workspaceEnrollment?.vaultRoot || currentWorkspace?.vaultRoot || undefined;
  const updateCount = workspaceInspection?.supportedAdapters.filter(item => item.deploymentStatus === "needs-update").length || 0;

  async function openCredentials() {
    try { await openModelSettingsWindow(); }
    catch (e) { setFeedback(`打开凭据设置失败：${(e as Error).message}`); }
  }

  useEffect(() => {
    function acceptRequestedWorkspace() {
      if (actionsBlocked) return;
      let requested: string | null;
      try {
        requested = localStorage.getItem("amo.workspace.requestedPath");
        if (requested) localStorage.removeItem("amo.workspace.requestedPath");
      } catch { return; }
      if (!requested) return;
      setActiveTab("deploy");
      setMaintenance(null);
      setEditingWorkspaceId(null);
      setDocumentMappingPath("");
      updateWorkspacePathInput(requested);
      void inspectWorkspace(requested);
    }
    acceptRequestedWorkspace();
    window.addEventListener("focus", acceptRequestedWorkspace);
    return () => window.removeEventListener("focus", acceptRequestedWorkspace);
  }, [actionsBlocked]);

  return (
    <main className="utility-window-shell workspace-center">
      <header className="wc-titlebar" onPointerDown={startUtilityWindowDrag}>
        <div><strong className="wc-brand">AMO</strong><span className="wc-divider" /><span>工作区中心</span><small>Workspace Center</small></div>
        <button type="button" className="wc-icon-button" aria-label="关闭工作区中心" onClick={() => void closeUtilityWindow("deploy")}><X size={16} /></button>
      </header>
      <div className="wc-shell">
        <aside className="wc-sidebar" aria-label="工作区列表">
          <div className="wc-sidebar-heading"><span>工作区</span><button type="button" className="wc-icon-button" aria-label="添加工作区" disabled={actionsBlocked} onClick={prepareNewWorkspace}><Plus size={16} /></button></div>
          <div className="wc-workspaces">
            {registeredWorkspaces.length === 0 && <p className="wc-help">选择一个目录，即可启动 CLI 或接入 AMO。</p>}
            {registeredWorkspaces.map(workspace => <button type="button" key={workspace.workspaceId} className="wc-workspace"
              aria-pressed={workspace.workspacePath === workspacePath} disabled={actionsBlocked} title={workspace.workspacePath}
              onClick={() => void selectRegisteredWorkspace(workspace)}>
              <Folder size={16} /><span><strong>{workspace.workspaceLabel || workspace.projectName}</strong><small>{!workspace.available ? "目录不可用" : workspace.enrollmentPresent ? `${workspace.workspaceLabel ? `${workspace.projectName} · ` : ""}已接入` : "未接入 AMO"}</small></span>
            </button>)}
            {!currentWorkspace && workspacePath && <button type="button" className="wc-workspace" aria-pressed="true" disabled={actionsBlocked} onClick={() => setActiveTab("launch")} title={workspacePath}><FolderOpen size={16} /><span><strong>{projectName(workspacePath)}</strong><small>当前目录 · 未登记</small></span></button>}
          </div>
          <div className="wc-sidebar-footer"><span className="wc-dot" />本机工作区</div>
        </aside>
        <div className="wc-main">
          <div className="wc-project-header">
            {(editingPath || !workspacePath) && <div className="wc-path-editor">
              <label htmlFor="wc-workspace-path">打开目录</label>
              <input id="wc-workspace-path" autoFocus spellCheck={false} value={workspacePath} disabled={actionsBlocked} placeholder="粘贴工作区路径，例如 G:\PROJECT\MyProject"
                onChange={e => updateWorkspacePathInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void inspectWorkspace(); }} />
              <div className="wc-row wc-between"><span className="wc-help">可直接普通启动，稍后再接入 AMO。</span><div className="wc-row">
                {workspacePath && <button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => setEditingPath(false)}>收起</button>}
                <button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => void chooseWorkspaceDirectory()}>选择文件夹</button>
                <button type="button" className="wc-button wc-primary" disabled={actionsBlocked || !workspacePath.trim()} onClick={() => void inspectWorkspace()}>{deployBusy === "inspect" ? "检查中…" : "打开并检查"}</button>
              </div></div>
            </div>}
            <div className="wc-project-heading"><h1>{workspacePath ? projectName(workspacePath) : "选择工作区"}</h1><div className="wc-row">
              <button type="button" className="wc-button wc-quiet" disabled={!workspacePath || actionsBlocked} onClick={() => void openDeploymentPath(workspacePath, "workspace")}><FolderOpen size={15} />目录</button>
              <button type="button" className="wc-button wc-quiet" disabled={!vaultPath || actionsBlocked} onClick={() => void openDeploymentPath(vaultPath, "vault")}><BookOpen size={15} />Vault</button>
            </div></div>
            <div className="wc-path"><Folder size={14} /><span title={workspacePath}>{workspacePath || "尚未选择目录"}</span><button type="button" className="wc-icon-button" aria-label="修改工作区目录" disabled={actionsBlocked} onClick={() => setEditingPath(true)}><Pencil size={13} /></button></div>
            <nav className="wc-tabs" role="tablist" aria-label="工作区操作">
              {([['launch', '启动'], ['deploy', '接入与更新'], ['settings', '工作区设置']] as const).map(([id, label]) =>
                <button type="button" role="tab" id={`wc-tab-${id}`} aria-controls={`wc-panel-${id}`} aria-selected={activeTab === id} key={id} onClick={() => setActiveTab(id)}>{label}{id === "deploy" && updateCount > 0 && <span className="wc-warning">{updateCount}</span>}</button>)}
            </nav>
          </div>
          <div className="wc-panel" id="wc-panel-launch" role="tabpanel" aria-labelledby="wc-tab-launch" hidden={activeTab !== "launch"}>
            <WorkspaceLaunchForm workspacePath={workspacePath} inspection={workspaceInspection} busy={actionsBlocked}
              onLaunch={launchWorkspace} onDeploy={() => setActiveTab("deploy")} onCredentials={() => void openCredentials()} onBusyChange={setCredentialBusy} />
          </div>
          <div className="wc-panel" id="wc-panel-deploy" role="tabpanel" aria-labelledby="wc-tab-deploy" hidden={activeTab !== "deploy"}>
            <div className="wc-notice"><div><strong>{updateCount ? `${updateCount} 个客户端有接入更新` : workspaceInspection?.existingEnrollment ? "当前工作区已接入 AMO" : "选择需要接入 AMO 的客户端"}</strong><p className="wc-help">{workspaceInspection ? workspaceDeploymentSummary(workspaceInspection) : "检查目录以查看可接入的客户端；检查操作不会写入文件。"}</p></div>
              <button type="button" className="wc-button" disabled={!workspacePath.trim() || actionsBlocked} onClick={() => void inspectWorkspace()}><RefreshCw size={14} />{deployBusy === "inspect" ? "检查中…" : "重新检查"}</button>
            </div>
            <div className="wc-row wc-between wc-list-heading"><span>客户端接入</span><span>当前工作区状态</span></div>
            {workspaceInspection?.supportedAdapters.map(adapter => {
              const status = adapter.deploymentStatus;
              const selectable = isDeployableWorkspaceAdapter(adapter);
              return <article className="wc-adapter" key={adapter.id}>
                <input type="checkbox" aria-label={`选择 ${adapter.label} 接入`} checked={selectedDeployAdapters.includes(adapter.id)} disabled={!selectable || actionsBlocked}
                  onChange={e => setSelectedDeployAdapters(current => e.target.checked ? [...new Set([...current, adapter.id])] : current.filter(id => id !== adapter.id))} />
                <div><strong>{adapter.label}</strong><p>{adapter.reason}</p>{adapter.deploymentIssues?.length ? <details><summary>查看接入问题</summary><ul>{adapter.deploymentIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></details> : null}</div>
                <div className="wc-adapter-status"><span className={status === "deployed" ? "wc-good" : status === "needs-update" ? "wc-warning" : ""}>{status === "deployed" ? "已接入" : status === "needs-update" ? "可更新" : selectable ? "未接入" : "不可接入"}</span><small>{adapterContextLabel(adapter)}</small></div>
              </article>;
            })}
            {workspaceInspection?.deferredAdapters?.map(adapter => <div className="wc-notice" key={adapter.id}><span>{adapter.label}：{adapter.reason || "暂不支持接入"}</span></div>)}
            <p className="wc-help wc-deploy-help">部署范围为当前工作区，已有接入可重新部署。</p>
            <div className="wc-launch-footer"><span className="wc-help">已选择 {selectedDeployAdapters.length} 个客户端</span><button type="button" className="wc-button wc-primary" disabled={!workspaceInspection || !selectedDeployAdapters.length || actionsBlocked} onClick={() => void enrollWorkspace()}><Download size={15} />{deployBusy === "enroll" ? "正在部署…" : "部署 / 更新选中项"}</button></div>
            {workspaceEnrollment && <div className="wc-notice wc-deploy-result"><span>部署完成 · {workspaceEnrollment.installedFiles.length} 个文件，{workspaceEnrollment.mergedFiles.length} 个合并</span><button type="button" className="wc-link" onClick={() => setActiveTab("launch")}>前往启动 →</button></div>}
          </div>
          <div className="wc-panel wc-settings" id="wc-panel-settings" role="tabpanel" aria-labelledby="wc-tab-settings" hidden={activeTab !== "settings"}>
            <section className="wc-setting-block"><div className="wc-setting-row"><div><h2>工作区备注</h2><p className="wc-help">用于列表显示和任务命名。</p></div>
              {currentWorkspace ? editingWorkspaceId === currentWorkspace.workspaceId ? <form className="wc-row" onSubmit={e => { e.preventDefault(); void saveWorkspaceLabel(currentWorkspace); }}><input aria-label="工作区备注" maxLength={32} autoFocus value={workspaceLabelDraft} disabled={actionsBlocked} onChange={e => setWorkspaceLabelDraft(e.target.value)} /><button type="submit" className="wc-button" disabled={actionsBlocked}><Check size={14} />保存</button><button type="button" className="wc-icon-button" aria-label="取消修改备注" onClick={() => setEditingWorkspaceId(null)}><X size={14} /></button></form>
                : <button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => beginWorkspaceLabelEdit(currentWorkspace)}><Pencil size={14} />{currentWorkspace.workspaceLabel || "设置备注"}</button>
                : <span className="wc-help">接入工作区后可设置</span>}
            </div></section>
            <section className="wc-setting-block"><div className="wc-setting-row"><div><h2>Git 本地排除</h2><p className="wc-help">将 AMO 生成文件加入本机 Git 排除规则。</p></div><span className="wc-help">{gitExcludeStatus?.status || "尚未检查"}</span></div>
              <details><summary>查看与修改规则</summary><div className="wc-settings-detail">
                <label className="wc-field"><span>Git 仓库目录</span><input value={gitRootPath} aria-label="Git 仓库目录" disabled={actionsBlocked} onChange={e => updateGitRootPathInput(e.target.value)} placeholder="可选，自动检测仓库根目录" /></label>
                <label className="wc-check"><input type="checkbox" checked={includeClaudeSettingsExclude} disabled={actionsBlocked} onChange={e => updateClaudeSettingsExclude(e.target.checked)} />同时排除 .claude/settings.local.json</label>
                <div className="wc-row wc-between"><button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => void chooseGitDirectory()}>选择 Git 目录</button><button type="button" className="wc-button" disabled={actionsBlocked || !workspacePath.trim()} onClick={() => void applyGitExclude()}>{gitExcludeBusy ? "正在添加…" : "添加排除规则"}</button></div>
                <GitExcludeStatusView status={gitExcludeStatus} missingPatterns={gitExcludeMissingPatterns} trackedPatterns={gitExcludeTrackedPatterns} />
              </div></details>
            </section>
            <section className="wc-setting-block"><h2>项目文档映射</h2><p className="wc-help">在 Obsidian Vault 中打开项目文档，源文件保留在工程中。</p>
              <DocumentMappingsSection key={workspacePath} compact workspaceEnrolled={Boolean(workspaceInspection?.existingEnrollment)} mappingPath={documentMappingPath} status={workspaceInspection?.documentMappings ?? null} busy={documentMappingBusy} blocked={actionsBlocked}
                onMappingPathChange={setDocumentMappingPath} onChoose={() => void chooseDocumentMappingDirectory()} onDeploy={sourcePath => void deployDocumentMapping(sourcePath)} onRemove={entry => void removeDocumentMapping(entry)} onOpenPath={(path, label) => void openDeploymentPath(path, label)} />
            </section>
            <details className="wc-maintenance"><summary>维护与移除</summary><div className="wc-settings-detail">
              <div className="wc-setting-row"><div><h2>清理生成内容</h2><p className="wc-help">删除生成笔记、重置基础画布；保留 Hooks 和工作画布。</p></div><button type="button" className="wc-button wc-danger" disabled={actionsBlocked || !workspaceInspection?.existingEnrollment} onClick={() => setMaintenance("clean")}>清理</button></div>
              <div className="wc-setting-row"><div><h2>从列表移除工作区</h2><p className="wc-help">工程文件和已部署的 Hooks 会保留。</p></div><button type="button" className="wc-button wc-danger" disabled={actionsBlocked || !currentWorkspace} onClick={() => setMaintenance("forget")}>移除</button></div>
              {maintenance && <div className="wc-confirm" role="alert"><strong>{maintenance === "clean" ? "确认清理当前工作区的生成内容？" : "确认从列表移除当前工作区？"}</strong><p className="wc-help">{maintenance === "clean" ? "生成笔记将被删除，基础画布将被重置，此操作无法撤销。" : "仅移除工作区登记，工程文件与 Hooks 保留。"}</p><div className="wc-row"><button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => setMaintenance(null)}>取消</button><button type="button" className="wc-button wc-danger" disabled={actionsBlocked} onClick={() => { if (maintenance === "clean") void clearWorkspaceGenerated(); else if (currentWorkspace) void forgetRegisteredWorkspace(currentWorkspace); }}>确认{maintenance === "clean" ? "清理" : "移除"}</button></div></div>}
            </div></details>
          </div>
          <footer className="wc-statusbar" role="status" aria-live="polite"><span className="wc-dot" /><span title={feedback}>{feedback}</span></footer>
        </div>
      </div>
    </main>
  );
}
