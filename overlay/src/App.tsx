import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, Window as TauriWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  Bot,
  Bug,
  ChevronDown,
  ChevronUp,
  Clock,
  ClipboardCheck,
  FileText,
  FolderOpen,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  ListFilter,
  Map as MapIcon,
  Minimize2,
  Palette,
  RefreshCcw,
  CircleCheck,
  Search,
  Settings2,
  SquareTerminal,
  StickyNote,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import claudeCliIcon from "./assets/tool-icons/claude-cli.png";
import codexAppIcon from "./assets/tool-icons/codex-app.png";
import codexCliIcon from "./assets/tool-icons/codex-cli.png";
import kiroIdeIcon from "./assets/tool-icons/kiro-ide.png";
import type {
  ActivationCandidate,
  ActivationResult,
  AgentSession,
  BrokerDebugStatus,
  BrokerEnsureResult,
  FolderPickResult,
  ObsidianPluginHealth,
  ObsidianVaultRegistrationResult,
  OpenPathResult,
  SessionState,
  TargetBinding,
  WorkspaceCleanResult,
  WorkspaceAdapterPlan,
  WorkspaceEnrollment,
  WorkspaceGitExcludeResult,
  WorkspaceInspection,
  WorkspaceLaunchResult,
  WorkspaceMaintenanceStatus,
} from "./types";

const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
const BROKER_SESSION_EVENTS_URL = "http://127.0.0.1:17654/api/session-events";
const BROKER_OBSIDIAN_REGISTER_VAULT_URL = "http://127.0.0.1:17654/api/obsidian/register-vault";
const BROKER_SYNC_BACK_URL = "http://127.0.0.1:17654/api/sync-back";
const BROKER_WORKSPACE_INSPECT_URL = "http://127.0.0.1:17654/api/workspaces/inspect";
const BROKER_WORKSPACE_ENROLL_URL = "http://127.0.0.1:17654/api/workspaces/enroll";
const BROKER_WORKSPACE_GIT_EXCLUDE_URL = "http://127.0.0.1:17654/api/workspaces/git-exclude";
const BROKER_WORKSPACE_LAUNCH_URL = "http://127.0.0.1:17654/api/workspaces/launch";
const BROKER_WORKSPACE_STATUS_URL = "http://127.0.0.1:17654/api/workspaces/status";
const BROKER_WORKSPACE_CLEAN_VAULT_URL = "http://127.0.0.1:17654/api/workspaces/clean-vault";
const BROKER_DEBUG_URL = "http://127.0.0.1:17654/api/debug";
const BROKER_DEBUG_LOGS_URL = "http://127.0.0.1:17654/api/debug/logs";
const REFRESH_INTERVAL_MS = 3000;
const DEFAULT_OVERLAY_SIZE = { width: 380, height: 520 };
const COLLAPSED_OVERLAY_SIZE = { width: 264, height: 86 };
const DIALOG_SIZES = {
  deploy: { width: 760, height: 600 },
  settings: { width: 660, height: 500 },
};
const ATTENTION_VISUAL_ACTIVE_MS = 10_000;
const OBSIDIAN_PLUGIN_BOOTSTRAP_DELAY_MS = 1200;
const OBSIDIAN_PLUGIN_RELOAD_HINT = "Restart Obsidian or reload the AMO plugin if this vault is already open.";
const SCRATCHPAD_TEXT_STORAGE_KEY = "amo.scratchpad.text";
const SCRATCHPAD_SHORTCUT_STORAGE_KEY = "amo.scratchpad.shortcut";
const AMO_THEME_STORAGE_KEY = "amo.theme";
const CURRENT_WINDOW_LABEL = getCurrentWebviewWindow().label;

type ScratchpadShortcutButton = "mouse4" | "mouse5";
type UtilityWindowKind = "deploy" | "settings";
type AmoWindowLabel = "main" | "scratchpad" | "deploy" | "settings";
type AmoTheme = "dark" | "light";

const AMO_FLOATING_WINDOWS: AmoWindowLabel[] = ["main", "scratchpad"];
const AMO_UTILITY_WINDOWS: UtilityWindowKind[] = ["deploy", "settings"];
const AMO_WINDOW_LABELS: AmoWindowLabel[] = [...AMO_FLOATING_WINDOWS, ...AMO_UTILITY_WINDOWS];

interface ScratchpadShortcutState {
  enabled: boolean;
  button: ScratchpadShortcutButton;
}

interface UtilityWindowStateEvent {
  label: UtilityWindowKind;
  open: boolean;
}

interface AmoThemeChangedEvent {
  theme: AmoTheme;
}

type SettingsSection = "scratchpad" | "theme";
type SessionFilter = "all" | "attention" | "idle";
type BrokerReadinessState = "checking" | "starting" | "ready" | "error";

interface BrokerReadiness {
  state: BrokerReadinessState;
  message: string;
  detail?: string | null;
}

const sessionFilterLabels: Record<SessionFilter, string> = {
  all: "All",
  attention: "Attention",
  idle: "Idle",
};

const brokerReadinessLabels: Record<BrokerReadinessState, string> = {
  checking: "broker checking",
  starting: "broker starting",
  ready: "broker live",
  error: "broker offline",
};

interface ScratchpadShortcutResult {
  ok: boolean;
  enabled: boolean;
  button: ScratchpadShortcutButton;
  message: string;
}

function brokerSessionTargetBindingUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/target-binding`;
}

function brokerSessionTargetBindingClearUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/target-binding/clear`;
}

function brokerSessionReviewedUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/reviewed`;
}

function brokerSessionDismissUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/dismiss`;
}

function brokerSessionTaskTitleUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/task-title`;
}

async function postBrokerJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `broker returned ${response.status}`);
  }

  return payload as T;
}

function startUtilityWindowDrag(event: PointerEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest("button, input, select, textarea, label")) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

async function closeUtilityWindow(label: UtilityWindowKind) {
  const payload = { label, open: false } satisfies UtilityWindowStateEvent;
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
  await getCurrentWindow().hide().catch(() => undefined);
  await setAmoWindowAlwaysOnTop(label, false);
  await setAmoWindowAlwaysOnTop("main", true);
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
}

function useUtilityWindowLifecycle(label: UtilityWindowKind) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void closeUtilityWindow(label);
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, [label]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeUtilityWindow(label);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [label]);
}

function isUtilityWindowLabel(label: string): label is UtilityWindowKind {
  return label === "deploy" || label === "settings";
}

async function getAmoWindow(label: AmoWindowLabel) {
  return label === CURRENT_WINDOW_LABEL ? getCurrentWindow() : await TauriWindow.getByLabel(label);
}

async function setAmoWindowAlwaysOnTop(label: AmoWindowLabel, alwaysOnTop: boolean) {
  const target = await getAmoWindow(label);
  await target?.setAlwaysOnTop(alwaysOnTop).catch(() => undefined);
}

async function setAmoWindowsAlwaysOnTop(alwaysOnTop: boolean) {
  await Promise.all(AMO_WINDOW_LABELS.map((label) => setAmoWindowAlwaysOnTop(label, alwaysOnTop)));
}

async function bringUtilityWindowToFront(label: UtilityWindowKind) {
  const target = await getAmoWindow(label);
  await setAmoWindowAlwaysOnTop("main", false);
  await Promise.all(
    AMO_UTILITY_WINDOWS.filter((utilityLabel) => utilityLabel !== label).map((utilityLabel) =>
      setAmoWindowAlwaysOnTop(utilityLabel, false),
    ),
  );
  await setAmoWindowAlwaysOnTop(label, true);
  await target?.show().catch(() => undefined);
  await target?.setFocus().catch(() => undefined);
}

async function restoreAmoWindowLayerAfterNativeDialog() {
  await Promise.all(AMO_FLOATING_WINDOWS.map((label) => setAmoWindowAlwaysOnTop(label, true)));

  if (isUtilityWindowLabel(CURRENT_WINDOW_LABEL)) {
    await bringUtilityWindowToFront(CURRENT_WINDOW_LABEL);
    return;
  }

  await Promise.all(AMO_UTILITY_WINDOWS.map((label) => setAmoWindowAlwaysOnTop(label, false)));
  await getCurrentWindow().setFocus().catch(() => undefined);
}

async function runWithNativeDialogLayer<T>(operation: () => Promise<T>): Promise<T> {
  await setAmoWindowsAlwaysOnTop(false);
  await sleep(40);

  try {
    return await operation();
  } finally {
    await restoreAmoWindowLayerAfterNativeDialog();
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadScratchpadShortcutState(): ScratchpadShortcutState {
  try {
    const raw = localStorage.getItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY);
    if (!raw) return { enabled: true, button: "mouse4" };
    const parsed = JSON.parse(raw) as Partial<ScratchpadShortcutState>;
    return {
      enabled: parsed.enabled !== false,
      button: parsed.button === "mouse5" ? "mouse5" : "mouse4",
    };
  } catch {
    return { enabled: true, button: "mouse4" };
  }
}

function saveScratchpadShortcutState(next: ScratchpadShortcutState) {
  localStorage.setItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY, JSON.stringify(next));
}

async function applyScratchpadShortcutState(next: ScratchpadShortcutState) {
  return invoke<ScratchpadShortcutResult>("set_scratchpad_shortcut_config", { config: next });
}

function normalizeAmoTheme(value: unknown): AmoTheme {
  return value === "light" ? "light" : "dark";
}

function loadAmoTheme(): AmoTheme {
  try {
    return normalizeAmoTheme(localStorage.getItem(AMO_THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

function applyAmoTheme(theme: AmoTheme) {
  document.documentElement.dataset.amoTheme = theme;
}

function saveAmoTheme(theme: AmoTheme) {
  try {
    localStorage.setItem(AMO_THEME_STORAGE_KEY, theme);
  } catch {
    // The visual preference still applies to the current window even if storage is unavailable.
  }
  applyAmoTheme(theme);
}

async function broadcastAmoTheme(theme: AmoTheme) {
  const payload = { theme } satisfies AmoThemeChangedEvent;
  await Promise.all(
    AMO_WINDOW_LABELS.map((label) =>
      getCurrentWindow()
        .emitTo(label, "amo-theme-changed", payload)
        .catch(() => undefined),
    ),
  );
}

function useAmoThemeRuntime(): [AmoTheme, (next: AmoTheme) => Promise<void>] {
  const [theme, setTheme] = useState<AmoTheme>(() => loadAmoTheme());

  useEffect(() => {
    applyAmoTheme(theme);
  }, [theme]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<AmoThemeChangedEvent>("amo-theme-changed", (event) => {
        const nextTheme = normalizeAmoTheme(event.payload?.theme);
        setTheme(nextTheme);
        saveAmoTheme(nextTheme);
      })
      .then((handler) => {
        unlisten = handler;
      });

    function handleStorage(event: StorageEvent) {
      if (event.key !== AMO_THEME_STORAGE_KEY) return;
      const nextTheme = normalizeAmoTheme(event.newValue);
      setTheme(nextTheme);
      applyAmoTheme(nextTheme);
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      unlisten?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  async function updateTheme(next: AmoTheme) {
    setTheme(next);
    saveAmoTheme(next);
    await broadcastAmoTheme(next);
  }

  return [theme, updateTheme];
}

applyAmoTheme(loadAmoTheme());

const stateLabel: Record<SessionState, string> = {
  starting: "Starting",
  running: "Running",
  waiting_permission: "Permission",
  waiting_user: "User",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

type ToolDisplayId = "codex-cli" | "codex-app" | "claude-cli" | "kiro-ide" | "other";
type ToolDisplay = { label: string; icon: string | null; badge?: string };

const toolDisplay: Record<ToolDisplayId, ToolDisplay> = {
  "codex-cli": {
    label: "Codex CLI",
    icon: codexCliIcon,
    badge: "CLI",
  },
  "codex-app": {
    label: "Codex App",
    icon: codexAppIcon,
  },
  "claude-cli": {
    label: "Claude CLI",
    icon: claudeCliIcon,
    badge: "CLI",
  },
  "kiro-ide": {
    label: "Kiro IDE",
    icon: kiroIdeIcon,
  },
  other: {
    label: "Agent",
    icon: null,
  },
};

function toolDisplayIdForSession(session: AgentSession): ToolDisplayId {
  const rawTool = String(session.tool || "").toLowerCase();
  const windowText = [
    session.windowHint?.process,
    session.windowHint?.title,
    session.windowHint?.boundLabel,
    session.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (rawTool.includes("codex-app") || windowText.includes("codex app")) {
    return "codex-app";
  }
  if (rawTool.includes("codex")) {
    return "codex-cli";
  }
  if (rawTool.includes("claude")) {
    return "claude-cli";
  }
  if (rawTool.includes("kiro")) {
    return "kiro-ide";
  }

  return "other";
}

function toolDisplayForSession(session: AgentSession) {
  return toolDisplay[toolDisplayIdForSession(session)];
}

function isCodexSession(session: AgentSession) {
  const rawTool = String(session.tool || "").toLowerCase();
  return rawTool.includes("codex") || toolDisplayIdForSession(session).startsWith("codex");
}

function codexAppThreadUri(threadId: string) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function codexAppTargetForSession(session: AgentSession): TargetBinding {
  return {
    type: "codex-app-thread",
    label: "Codex App",
    threadId: session.sessionId,
    uri: codexAppThreadUri(session.sessionId),
  };
}

function codexCliTargetForSession(session: AgentSession): TargetBinding {
  return {
    type: "codex-cli-session",
    label: "Codex CLI",
    sessionId: session.sessionId,
    workspacePath: workspacePathForSession(session),
  };
}

function windowTargetForSession(session: AgentSession): TargetBinding | null {
  const hint = session.windowHint;
  if (!hint || (!hint.hwnd && !hint.pid)) {
    return null;
  }

  return {
    type: "window",
    label: hint.boundLabel ?? hint.title ?? hint.process ?? "Window",
    hwnd: hint.hwnd ?? null,
    processId: hint.pid ?? null,
    processName: hint.process ?? null,
    title: hint.title ?? null,
    boundAt: hint.boundAt ?? null,
    boundBy: hint.boundBy ?? null,
  };
}

function targetBindingForSession(session: AgentSession): TargetBinding | null {
  return session.targetBinding ?? null;
}

function activationTargetForSession(session: AgentSession): TargetBinding | null {
  return targetBindingForSession(session) ?? windowTargetForSession(session);
}

function activationCandidateFromWindowTarget(target: TargetBinding | null): ActivationCandidate | null {
  if (!target || target.type !== "window" || (!target.hwnd && !target.processId)) {
    return null;
  }

  return {
    hwnd: target.hwnd ?? 0,
    processId: target.processId ?? 0,
    processName: target.processName ?? null,
    title: target.title ?? target.label ?? "Window",
    label: target.label ?? target.title ?? target.processName ?? "Window",
  };
}

function targetLabelForSession(session: AgentSession) {
  const target = targetBindingForSession(session);
  if (!target) return "Choose target";
  if (target.type === "codex-app-thread") return "Codex App";
  if (target.type === "codex-cli-session") return "Codex CLI";
  return target.label ?? target.title ?? target.processName ?? "Window";
}

function clipboardPromptForSession(session: AgentSession) {
  const prompt = session.pendingPrompt ?? "";
  const target = targetBindingForSession(session);
  if (target?.type === "codex-app-thread") {
    return prompt;
  }

  return prompt.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\\n");
}

function projectName(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function isDeployableWorkspaceAdapter(adapter: WorkspaceAdapterPlan) {
  return typeof adapter.deployable === "boolean" ? adapter.deployable : adapter.status === "available";
}

function adapterStateLabel(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus ?? adapter.status;
}

function adapterContextLabel(adapter: WorkspaceAdapterPlan) {
  return adapter.workspaceState ?? adapter.confidence;
}

function isWorkspaceAdapterDeployed(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus === "deployed";
}

function selectedWorkspaceAdapterIds(inspection: WorkspaceInspection) {
  return inspection.supportedAdapters
    .filter((adapter) => isDeployableWorkspaceAdapter(adapter) && adapter.recommended !== false && !isWorkspaceAdapterDeployed(adapter))
    .map((adapter) => adapter.id);
}

function workspaceDeploymentSummary(inspection: WorkspaceInspection) {
  const deployedCount = inspection.supportedAdapters.filter(isWorkspaceAdapterDeployed).length;
  const deployableCount = inspection.supportedAdapters.filter(isDeployableWorkspaceAdapter).length;
  const empty = inspection.supportedAdapters.some((adapter) => adapter.workspaceState === "empty");

  if (empty && deployedCount === 0) {
    return "Empty folder, no AMO hooks deployed.";
  }

  if (deployedCount === 0) {
    return `No AMO hooks deployed. ${deployableCount} adapter(s) can be installed.`;
  }

  const pendingCount = Math.max(0, deployableCount - deployedCount);
  if (pendingCount > 0) {
    return `${deployedCount} deployed, ${pendingCount} available to deploy.`;
  }

  return `${deployedCount} adapter(s) deployed.`;
}

function workspaceDeploymentStateLabel(inspection: WorkspaceInspection) {
  const deployedCount = inspection.supportedAdapters.filter(isWorkspaceAdapterDeployed).length;
  const empty = inspection.supportedAdapters.some((adapter) => adapter.workspaceState === "empty");
  if (deployedCount > 0) return "deployed";
  return empty ? "empty" : "not deployed";
}

function workspaceGeneratedNoteCount(status: WorkspaceMaintenanceStatus | null | undefined) {
  if (!status) return 0;
  return status.counts.generatedNotes ?? status.counts.replyNotes + status.counts.promptNotes;
}

function workspaceUsesSessionLayoutV2(status: WorkspaceMaintenanceStatus | null | undefined) {
  const canvasPath = status?.paths?.canvas?.replace(/\\/g, "/") ?? "";
  return canvasPath.endsWith("Canvases/AgentFlow.base.canvas") && status?.canvas?.marker?.canvasType === "agent-flow-base";
}

function workspaceCleanFeedback(result: WorkspaceCleanResult) {
  const summary = `Cleared ${workspaceGeneratedNoteCount(result.before)} generated note(s) and reset ${result.before.counts.canvasNodes} canvas node(s).`;
  if (!workspaceUsesSessionLayoutV2(result.after)) {
    return `${summary} Legacy layout still detected; restart AMO/broker, then run Deploy/Update to switch this workspace to session layout v2.`;
  }
  return `${summary} New turns will use session layout v2.`;
}

function formatAgo(updatedAt: string) {
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

function joinWindowsPath(root: string | undefined, relativePath: string | undefined) {
  if (!root || !relativePath) {
    return null;
  }

  const normalizedRelative = relativePath.replace(/\//g, "\\").replace(/^\\+/, "");
  return `${root.replace(/[\\/]+$/, "")}\\${normalizedRelative}`;
}

function notePathForOpen(session: AgentSession) {
  return (
    session.lastReplyNoteAbsolutePath ??
    joinWindowsPath(session.vaultRoot, session.lastReplyNote) ??
    joinWindowsPath(session.workspacePath, session.lastReplyNote)
  );
}

function canvasPathForOpen(session: AgentSession) {
  return (
    session.canvasAbsolutePath ??
    joinWindowsPath(session.vaultRoot, session.canvasPath) ??
    joinWindowsPath(session.workspacePath, session.canvasPath)
  );
}

function workspacePathForSession(session: AgentSession) {
  return session.workspacePath ?? session.windowHint?.cwd ?? session.cwd;
}

function latestCanvasNotePathForFocus(session: AgentSession) {
  const candidates = [
    {
      path:
        session.pendingAnnotationSource?.notePath && session.vaultRoot
          ? joinWindowsPath(session.vaultRoot, session.pendingAnnotationSource.notePath)
          : session.pendingAnnotationSource?.notePath,
      at: session.pendingPromptCreatedAt,
    },
    {
      path:
        session.sentPromptNoteAbsolutePath ??
        joinWindowsPath(session.vaultRoot, session.sentPromptNote ?? undefined) ??
        joinWindowsPath(session.workspacePath, session.sentPromptNote ?? undefined),
      at: session.sentPromptRecordedAt,
    },
    {
      path:
        session.lastPromptNoteAbsolutePath ??
        joinWindowsPath(session.vaultRoot, session.lastPromptNote) ??
        joinWindowsPath(session.workspacePath, session.lastPromptNote),
      at: session.lastPromptAt,
    },
    {
      path: notePathForOpen(session),
      at: session.lastReplyAt,
    },
  ].filter((candidate): candidate is { path: string; at: string | null | undefined } => Boolean(candidate.path));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => timestampValue(b.at) - timestampValue(a.at))[0].path;
}

function timestampValue(value?: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function obsidianOpenUri(targetPath: string, vaultId?: string, vaultRoot?: string) {
  const params: Record<string, string> = {};
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);

  if (vaultId && filePath) {
    params.vault = vaultId;
    params.file = filePath;
  } else {
    params.path = targetPath;
  }

  params.paneType = "tab";
  return `obsidian://open?${uriQuery(params)}`;
}

function obsidianAmoOpenUri(
  targetPath: string,
  target: "note" | "canvas",
  vaultId?: string,
  vaultRoot?: string,
  options?: { focusNotePath?: string | null },
) {
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);
  if (!filePath) {
    return obsidianOpenUri(targetPath, vaultId, vaultRoot);
  }

  const params: Record<string, string> = {
    path: targetPath,
    relativePath: filePath,
    kind: target,
  };
  if (options?.focusNotePath) {
    const focusNotePath = vaultRelativeFilePath(options.focusNotePath, vaultRoot) ?? options.focusNotePath;
    params.focusNotePath = focusNotePath;
  }
  return `obsidian://amo-open?${uriQuery(params)}`;
}

function uriQuery(params: Record<string, string>) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function vaultRelativeFilePath(targetPath: string, vaultRoot: string | undefined) {
  if (!vaultRoot) {
    return null;
  }

  const normalizedRoot = normalizeWindowsPath(vaultRoot).replace(/\\+$/, "");
  const normalizedTarget = normalizeWindowsPath(targetPath);
  const rootPrefix = `${normalizedRoot}\\`;

  if (
    normalizedTarget.toLowerCase() !== normalizedRoot.toLowerCase() &&
    !normalizedTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())
  ) {
    return null;
  }

  return normalizedTarget.slice(rootPrefix.length).replace(/\\/g, "/");
}

function normalizeWindowsPath(value: string) {
  return value.replace(/\//g, "\\");
}

function shortPathLabel(value: string | undefined) {
  if (!value) {
    return "";
  }

  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function pluginHealthTitle(health: ObsidianPluginHealth) {
  const lines = [
    `${health.pluginId}: ${health.status}`,
    health.installedVersion ? `version ${health.installedVersion}` : "version missing",
    health.expectedVersion ? `expected ${health.expectedVersion}` : "",
    health.dataBridgeUrl ? `bridge ${health.dataBridgeUrl}` : "",
  ].filter(Boolean);

  if (health.issues && health.issues.length > 0) {
    lines.push(...health.issues);
  }

  return lines.join("\n");
}

type MaintenanceTone = "ok" | "warning" | "error" | "unknown";

function maintenanceToneForSession(session: AgentSession, status?: WorkspaceMaintenanceStatus | null): MaintenanceTone {
  const pluginHealth = status?.pluginHealth ?? session.obsidianPluginHealth;
  if (status && !status.ok) {
    if (!status.exists.vaultRoot || !status.exists.canvas || !status.canvas.readable || pluginHealth?.status === "missing") {
      return "error";
    }
    return "warning";
  }
  if (pluginHealth && !pluginHealth.ok) {
    return pluginHealth.status === "missing" ? "error" : "warning";
  }
  if (!session.workspacePath && !session.vaultRoot) {
    return "unknown";
  }
  return "ok";
}

function maintenanceTitleForSession(session: AgentSession) {
  const tone = maintenanceToneForSession(session);
  const health = session.obsidianPluginHealth;
  const lines = ["Workspace tools"];
  if (tone === "warning" || tone === "error") {
    lines.push("Needs review");
  }
  if (health?.issues?.length) {
    lines.push(...health.issues);
  }
  return lines.join("\n");
}

function menuPosition(x?: number, y?: number) {
  const fallbackX = Math.max(12, window.innerWidth - 326);
  const fallbackY = 96;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - 326)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 220)),
  };
}

function workspacePanelPosition(x?: number, y?: number) {
  const width = 356;
  const fallbackX = Math.max(12, window.innerWidth - width - 8);
  const fallbackY = 92;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - width - 10)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 360)),
  };
}

function normalizeSessions(value: unknown): AgentSession[] | null {
  if (Array.isArray(value)) {
    return value as AgentSession[];
  }

  if (value && typeof value === "object" && "sessions" in value) {
    const sessions = (value as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as AgentSession[]) : null;
  }

  return null;
}

function mergeSessionOrder(previousOrder: string[], nextSessions: AgentSession[]) {
  const nextIds = nextSessions.map((session) => session.sessionId);
  const keptIds = previousOrder.filter((sessionId) => nextIds.includes(sessionId));
  const addedIds = nextIds.filter((sessionId) => !keptIds.includes(sessionId));
  return [...keptIds, ...addedIds];
}

function applySessionOrder(sessions: AgentSession[], order: string[]) {
  const indexed = new Map(order.map((sessionId, index) => [sessionId, index]));
  return [...sessions].sort((a, b) => {
    const aIndex = indexed.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = indexed.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }

    return `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
  });
}

function mergeChangedSession(previousSessions: AgentSession[], changedSession: AgentSession) {
  const index = previousSessions.findIndex((session) => session.sessionId === changedSession.sessionId);
  if (index >= 0) {
    const nextSessions = [...previousSessions];
    nextSessions[index] = changedSession;
    return nextSessions;
  }

  return [changedSession, ...previousSessions];
}

function sessionNeedsReview(session: AgentSession) {
  return Boolean(session.reviewRequired && session.reviewStatus !== "reviewed" && !session.reviewedAt);
}

function sessionHasAttentionSignal(session: AgentSession) {
  return Boolean(session.needsAttention || sessionNeedsReview(session));
}

function sessionAttentionKey(session: AgentSession) {
  return [
    session.sessionId,
    session.updatedAt,
    session.state,
    session.lastEvent,
    session.lastMessage,
    session.needsAttention ? "attention" : "quiet",
    session.lastReplyAt ?? "",
    session.lastPromptAt ?? "",
    session.pendingPromptId ?? "",
    session.reviewStatus ?? "",
    session.reviewRequestedAt ?? "",
    session.reviewedAt ?? "",
  ].join("|");
}

function sessionAttentionTime(session: AgentSession) {
  const timestamp =
    session.reviewRequestedAt ||
    session.updatedAt ||
    session.lastReplyAt ||
    session.lastPromptAt ||
    session.pendingPromptCreatedAt ||
    session.sentPromptRecordedAt;
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionAttentionVisualActive(session: AgentSession, visuallySeen: boolean, now: number) {
  if (!sessionHasAttentionSignal(session) || visuallySeen) {
    return false;
  }

  const timestamp = sessionAttentionTime(session);
  if (timestamp === null) {
    return true;
  }

  const age = now - timestamp;
  return age <= ATTENTION_VISUAL_ACTIVE_MS && age >= -ATTENTION_VISUAL_ACTIVE_MS;
}

function sessionMatchesFilter(session: AgentSession, filter: SessionFilter) {
  if (filter === "attention") {
    return sessionHasAttentionSignal(session);
  }
  if (filter === "idle") {
    return session.state === "idle";
  }
  return true;
}

function sessionMatchesSearch(session: AgentSession, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const target = targetBindingForSession(session);
  const haystack = [
    session.sessionId,
    session.taskTitle,
    session.title,
    projectName(session.cwd || ""),
    session.cwd,
    session.workspacePath,
    session.vaultRoot,
    session.tool,
    toolDisplayForSession(session).label,
    session.state,
    session.lastEvent,
    session.lastMessage,
    session.lastReplyNote,
    session.lastPromptNote,
    session.pendingPrompt,
    session.windowHint?.process,
    session.windowHint?.title,
    session.windowHint?.boundLabel,
    target?.label,
    target?.title,
    target?.processName,
    target?.threadId,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

interface CardDragState {
  sessionId: string;
  pointerId: number;
  pointerY: number;
  offsetY: number;
  left: number;
  width: number;
  height: number;
}

interface CandidateMenuState {
  session: AgentSession;
  candidates: ActivationCandidate[];
  x: number;
  y: number;
  bindOnSelect: boolean;
  codexAppAvailable: boolean;
  codexCliResumeAvailable: boolean;
}

interface WorkspacePanelState {
  session: AgentSession;
  x: number;
  y: number;
  status: WorkspaceMaintenanceStatus | null;
  busy: "status" | "clean" | "open" | "task-title" | null;
  error: string | null;
  taskTitleDraft: string;
}

interface CleanConfirmState {
  session: AgentSession;
  workspacePath: string;
  replyNotes: number;
  promptNotes: number;
  canvasNodes: number;
}

interface ObsidianVaultRecoveryState {
  session: AgentSession;
  target: "note" | "canvas";
  targetPath: string;
  focusNotePath?: string | null;
  vaultRoot: string;
  vaultId: string;
  runtimeConfigPath?: string | null;
  obsidianProcessCount?: number | null;
  busy: "explorer" | "copy" | null;
}

interface ResizeState {
  mode: "vertical" | "horizontal" | "both";
  startScreenX: number;
  startScreenY: number;
  startWidth: number;
  startHeight: number;
}

function ToolMark({ session }: { session: AgentSession }) {
  const displayId = toolDisplayIdForSession(session);
  const display = toolDisplay[displayId];

  return (
    <span className={`tool-mark tool-${displayId}`} title={display.label}>
      {display.icon ? <img src={display.icon} alt="" aria-hidden="true" /> : <Bot size={18} strokeWidth={2.1} aria-hidden="true" />}
      {display.badge ? <span className="tool-badge">{display.badge}</span> : null}
    </span>
  );
}

function SessionRowContent({
  session,
  activating,
  openingTarget,
  unbindingWindow,
  reviewing,
  dismissing,
  attentionSignal,
  attentionVisualActive,
  onOpenNote,
  onOpenCanvas,
  onMarkReviewed,
  onUnbindWindow,
  onDismiss,
  onOpenCodexAppTarget,
  onActivateSession,
  onOpenWorkspacePanel,
}: {
  session: AgentSession;
  activating: boolean;
  openingTarget: "note" | "canvas" | null;
  unbindingWindow: boolean;
  reviewing: boolean;
  dismissing: boolean;
  attentionSignal: boolean;
  attentionVisualActive: boolean;
  onOpenNote: () => void;
  onOpenCanvas: () => void;
  onMarkReviewed: () => void;
  onUnbindWindow: () => void;
  onDismiss: () => void;
  onOpenCodexAppTarget: () => void;
  onActivateSession: () => void;
  onOpenWorkspacePanel: (x: number, y: number) => void;
}) {
  const notePath = notePathForOpen(session);
  const canvasPath = canvasPathForOpen(session);
  const windowBound = Boolean(session.windowHint?.hwnd || session.windowHint?.pid);
  const targetBinding = targetBindingForSession(session);
  const targetBound = Boolean(targetBinding);
  const codexAppAvailable = isCodexSession(session);
  const needsTargetChoice = codexAppAvailable && !targetBound;
  const noteOpening = openingTarget === "note";
  const canvasOpening = openingTarget === "canvas";
  const waitingForPermission = session.state === "waiting_permission";
  const failed = session.state === "failed";
  const reviewPending = sessionNeedsReview(session);
  const attentionTone = reviewPending ? "review" : waitingForPermission ? "permission" : failed ? "failed" : "attention";
  const display = toolDisplayForSession(session);
  const statusLabel = activating ? "Opening" : reviewPending ? "Review" : stateLabel[session.state];
  const maintenanceTone = maintenanceToneForSession(session);
  const sessionProjectName = projectName(session.cwd);
  const threadTitle = session.title?.trim() || sessionProjectName;
  const taskTitle = session.taskTitle?.trim() || "";
  const conversationTitle = taskTitle || threadTitle;
  const subtitleLabel = `${sessionProjectName} · ${statusLabel} · ${display.label} · ${formatAgo(session.updatedAt)}`;

  return (
    <span className="session-main">
      <button
        type="button"
        className={`card-maintenance-button tone-${maintenanceTone}`}
        title={maintenanceTitleForSession(session)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenWorkspacePanel(event.clientX, event.clientY);
        }}
      >
        <Settings2 size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`card-dismiss-button ${dismissing ? "is-busy" : ""}`}
        title="Dismiss this card"
        aria-label={`Dismiss ${session.title}`}
        aria-busy={dismissing}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
      >
        <X size={12} aria-hidden="true" />
      </button>
      <span className="session-head">
        <ToolMark session={session} />
        <span className="session-title">
          <span className="session-title-primary">
            {attentionSignal ? (
              <span
                className={`title-attention-beacon tone-${attentionTone} ${
                  attentionVisualActive ? "is-active" : "is-static"
                }`}
                aria-hidden="true"
              />
            ) : null}
            <strong title={conversationTitle}>{conversationTitle}</strong>
          </span>
          {taskTitle ? <span className="session-title-subtitle" title={threadTitle}>{threadTitle}</span> : null}
        </span>
        <span className="session-chip-row" title={subtitleLabel}>
          <span className="state-pill">
            <span className="state-dot" aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
          <span className="session-inline-meta">
            <span className="session-info-project">{sessionProjectName}</span>
            <span className="session-meta-separator">·</span>
            <span>
              {display.label} · {formatAgo(session.updatedAt)}
            </span>
          </span>
        </span>
      </span>
      <span className="session-body">
        <span className="message-line">{session.lastMessage}</span>
        <span className="session-meta">
          <span className="event-line">{session.lastEvent}</span>
          <span className="session-tags">
            {waitingForPermission ? (
              <span className="session-tag tag-attention" title="点击卡片切回 CLI，手动处理权限请求">
                Needs attention
              </span>
            ) : null}
            {reviewPending ? (
              <span className="session-tag tag-review" title="New reply is ready to review">
                Review
              </span>
            ) : null}
            {windowBound && !targetBound ? (
              <span className="session-tag" title={session.windowHint?.boundLabel ?? session.windowHint?.title ?? session.title}>
                Window hint
              </span>
            ) : null}
            {targetBound ? (
              <span className="session-tag target-tag" title={targetBinding?.label ?? targetLabelForSession(session)}>
                Target: {targetLabelForSession(session)}
              </span>
            ) : null}
          </span>
        </span>
        {reviewPending ||
        notePath ||
        canvasPath ||
        targetBound ||
        waitingForPermission ||
        failed ||
        codexAppAvailable ? (
          <span className="bridge-actions" aria-label="Bridge actions">
            {reviewPending ? (
              <button
                type="button"
                className={`row-tool-button review-button ${reviewing ? "is-busy" : ""}`}
                aria-busy={reviewing}
                title="Mark this reply as reviewed"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkReviewed();
                }}
              >
                <CircleCheck size={13} aria-hidden="true" />
                <span>Seen</span>
              </button>
            ) : null}
            {waitingForPermission || failed ? (
              <button
                type="button"
                className={`row-tool-button attention-action-button tone-${failed ? "failed" : "permission"} ${
                  activating ? "is-busy" : ""
                }`}
                aria-busy={activating}
                title={failed ? "Open target to inspect this failed run" : "Open target to handle the permission request"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                {failed ? <AlertTriangle size={13} aria-hidden="true" /> : <SquareTerminal size={13} aria-hidden="true" />}
                <span>{failed ? "Inspect" : "Handle"}</span>
              </button>
            ) : null}
            {notePath ? (
              <button
                type="button"
                className={`row-tool-button ${noteOpening ? "is-busy" : ""}`}
                aria-busy={noteOpening}
                title={`Open note: ${session.lastReplyNote ?? notePath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenNote();
                }}
              >
                <FileText size={13} aria-hidden="true" />
                <span>Note</span>
              </button>
            ) : null}
            {canvasPath ? (
              <button
                type="button"
                className={`row-tool-button ${canvasOpening ? "is-busy" : ""}`}
                aria-busy={canvasOpening}
                title={`Open canvas: ${session.canvasPath ?? canvasPath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCanvas();
                }}
              >
                <MapIcon size={13} aria-hidden="true" />
                <span>Canvas</span>
              </button>
            ) : null}
            {needsTargetChoice ? (
              <button
                type="button"
                className={`row-tool-button target-choice-button ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Choose Codex CLI or Codex App for this card"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                <ListFilter size={13} aria-hidden="true" />
                <span>Target</span>
              </button>
            ) : null}
            {targetBinding?.type === "codex-app-thread" ? (
              <button
                type="button"
                className={`row-tool-button codex-app-target-button ${
                  targetBinding?.type === "codex-app-thread" ? "is-target" : ""
                } ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Open and bind this card to Codex App"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCodexAppTarget();
                }}
              >
                <Bot size={13} aria-hidden="true" />
                <span>App</span>
              </button>
            ) : null}
            {targetBinding?.type === "codex-cli-session" ? (
              <button
                type="button"
                className={`row-tool-button codex-cli-target-button is-target ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Resume this session in Codex CLI"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                <SquareTerminal size={13} aria-hidden="true" />
                <span>CLI</span>
              </button>
            ) : null}
            {targetBound ? (
              <button
                type="button"
                className={`row-tool-button binding-button ${unbindingWindow ? "is-busy" : ""}`}
                aria-busy={unbindingWindow}
                title={`Unbind target: ${targetLabelForSession(session)}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onUnbindWindow();
                }}
              >
                <Unlink2 size={13} aria-hidden="true" />
                <span>Unbind</span>
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function ScratchpadApp() {
  useAmoThemeRuntime();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [textLength, setTextLength] = useState(0);
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const savedText = localStorage.getItem(SCRATCHPAD_TEXT_STORAGE_KEY) || "";
    textarea.value = savedText;
    setTextLength(savedText.length);
    window.setTimeout(() => textarea.focus(), 30);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      void getCurrentWindow().hide();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function persistCurrentText() {
    const text = textareaRef.current?.value || "";
    localStorage.setItem(SCRATCHPAD_TEXT_STORAGE_KEY, text);
    setTextLength(text.length);
    return text;
  }

  async function copyText() {
    const text = persistCurrentText();
    if (!text.trim()) {
      setStatus("Nothing to copy");
      textareaRef.current?.focus();
      return;
    }

    try {
      const result = await invoke<OpenPathResult>("write_clipboard_text", { text });
      setStatus(result.ok ? "Copied" : result.message);
      if (result.ok) {
        await getCurrentWindow().hide();
      }
    } catch (error) {
      setStatus(`Copy failed: ${(error as Error).message}`);
    } finally {
      textareaRef.current?.focus();
    }
  }

  function clearText() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    textarea.select();
    const deleted = document.execCommand("delete");
    if (!deleted) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    persistCurrentText();
    setStatus("Cleared · Ctrl+Z can restore while focused");
  }

  return (
    <main className="scratchpad-shell">
      <header className="scratchpad-header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <StickyNote size={15} aria-hidden="true" />
          <strong>AMO Scratchpad</strong>
        </div>
        <span className="scratchpad-header-actions">
          <button type="button" className="scratchpad-clear-button" title="Clear scratchpad" aria-label="Clear scratchpad" onClick={clearText}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
          <button type="button" title="Close" aria-label="Close scratchpad" onClick={() => void getCurrentWindow().hide()}>
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </header>
      <textarea
        ref={textareaRef}
        className="scratchpad-input"
        spellCheck={false}
        placeholder="Write the reply points you want to keep while reading..."
        onInput={() => {
          persistCurrentText();
          setStatus("Saved");
        }}
      />
      <footer className="scratchpad-footer">
        <span title={status}>
          {textLength} chars · {status}
        </span>
        <div>
          <button type="button" onClick={() => void copyText()}>
            Copy
          </button>
        </div>
      </footer>
    </main>
  );
}

function DeployWorkspaceApp() {
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
                  const deployed = isWorkspaceAdapterDeployed(adapter);
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
                        {deployed ? (
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

interface SettingsSidebarProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
}

function SettingsSidebar({ settingsSection, onSettingsSectionChange }: SettingsSidebarProps) {
  return (
    <aside className="settings-sidebar" aria-label="Settings sections">
      <strong>Sections</strong>
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "scratchpad" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("scratchpad")}
      >
        <StickyNote size={13} aria-hidden="true" />
        <span>Scratchpad</span>
      </button>
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "theme" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("theme")}
      >
        <Palette size={13} aria-hidden="true" />
        <span>Theme</span>
      </button>
    </aside>
  );
}

interface SettingsDetailHeaderProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  amoTheme: AmoTheme;
}

function SettingsDetailHeader({ settingsSection, scratchpadShortcut, amoTheme }: SettingsDetailHeaderProps) {
  const title = settingsSection === "theme" ? "Theme" : "Scratchpad";
  const status =
    settingsSection === "theme"
      ? amoTheme === "light"
        ? "Light"
        : "Dark"
      : scratchpadShortcut.enabled
        ? `Ctrl + ${scratchpadShortcut.button === "mouse5" ? "Mouse5" : "Mouse4"}`
        : "Disabled";

  return (
    <header className="settings-detail-header">
      <div>
        <strong>{title}</strong>
        <span>{status}</span>
      </div>
    </header>
  );
}

interface ScratchpadSettingsBodyProps {
  scratchpadShortcut: ScratchpadShortcutState;
  onScratchpadShortcutChange: (next: ScratchpadShortcutState) => void;
  onOpenScratchpadNow: () => void;
}

function ScratchpadSettingsBody({
  scratchpadShortcut,
  onScratchpadShortcutChange,
  onOpenScratchpadNow,
}: ScratchpadSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={scratchpadShortcut.enabled}
          onChange={(event) =>
            onScratchpadShortcutChange({
              ...scratchpadShortcut,
              enabled: event.currentTarget.checked,
            })
          }
        />
        <span>Enable global shortcut</span>
      </label>

      <label className="settings-field">
        <span>Shortcut</span>
        <select
          value={scratchpadShortcut.button}
          disabled={!scratchpadShortcut.enabled}
          onChange={(event) =>
            onScratchpadShortcutChange({
              ...scratchpadShortcut,
              button: event.currentTarget.value === "mouse5" ? "mouse5" : "mouse4",
            })
          }
        >
          <option value="mouse4">Ctrl + Mouse4</option>
          <option value="mouse5">Ctrl + Mouse5</option>
        </select>
      </label>

      <button type="button" className="settings-primary-action" onClick={onOpenScratchpadNow}>
        Open scratchpad now
      </button>
    </div>
  );
}

interface ThemeSettingsBodyProps {
  amoTheme: AmoTheme;
  onAmoThemeChange: (theme: AmoTheme) => void;
}

function ThemeSettingsBody({ amoTheme, onAmoThemeChange }: ThemeSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <div className="theme-choice-grid">
        <button
          type="button"
          className={`theme-choice ${amoTheme === "dark" ? "is-active" : ""}`}
          onClick={() => onAmoThemeChange("dark")}
        >
          <span className="theme-swatch theme-swatch-dark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Dark</strong>
          <span>Night workspace</span>
        </button>

        <button
          type="button"
          className={`theme-choice ${amoTheme === "light" ? "is-active" : ""}`}
          onClick={() => onAmoThemeChange("light")}
        >
          <span className="theme-swatch theme-swatch-light" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Light</strong>
          <span>Day workspace</span>
        </button>
      </div>
    </div>
  );
}

interface SettingsDetailProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  amoTheme: AmoTheme;
  onScratchpadShortcutChange: (next: ScratchpadShortcutState) => void;
  onOpenScratchpadNow: () => void;
  onAmoThemeChange: (theme: AmoTheme) => void;
}

function SettingsDetail({
  settingsSection,
  scratchpadShortcut,
  amoTheme,
  onScratchpadShortcutChange,
  onOpenScratchpadNow,
  onAmoThemeChange,
}: SettingsDetailProps) {
  return (
    <div className="settings-detail">
      <SettingsDetailHeader
        settingsSection={settingsSection}
        scratchpadShortcut={scratchpadShortcut}
        amoTheme={amoTheme}
      />

      {settingsSection === "scratchpad" ? (
        <ScratchpadSettingsBody
          scratchpadShortcut={scratchpadShortcut}
          onScratchpadShortcutChange={onScratchpadShortcutChange}
          onOpenScratchpadNow={onOpenScratchpadNow}
        />
      ) : (
        <ThemeSettingsBody amoTheme={amoTheme} onAmoThemeChange={onAmoThemeChange} />
      )}
    </div>
  );
}

interface BrokerReadinessPanelProps {
  readiness: BrokerReadiness;
  onRetry: () => void;
}

function BrokerReadinessPanel({ readiness, onRetry }: BrokerReadinessPanelProps) {
  const isError = readiness.state === "error";
  return (
    <div className={`broker-readiness-panel state-${readiness.state}`} role="status">
      <span className="broker-readiness-mark" aria-hidden="true">
        {isError ? <AlertTriangle size={16} /> : <RefreshCcw size={16} />}
      </span>
      <div>
        <strong>{readiness.message}</strong>
        {readiness.detail ? <span>{readiness.detail}</span> : null}
      </div>
      <button type="button" className="broker-retry-button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function SettingsWindowApp() {
  useUtilityWindowLifecycle("settings");
  const [amoTheme, setAmoThemePreference] = useAmoThemeRuntime();

  const [settingsSection, setSettingsSection] = useState<SettingsSection>("scratchpad");
  const [scratchpadShortcut, setScratchpadShortcut] = useState<ScratchpadShortcutState>(() =>
    loadScratchpadShortcutState(),
  );
  const [feedback, setFeedback] = useState("Settings ready.");

  async function updateScratchpadShortcut(next: ScratchpadShortcutState) {
    setScratchpadShortcut(next);
    saveScratchpadShortcutState(next);

    try {
      const result = await applyScratchpadShortcutState(next);
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad shortcut update failed: ${(error as Error).message}`);
    }
  }

  async function openScratchpadNow() {
    try {
      const result = await invoke<OpenPathResult>("show_scratchpad_at_cursor");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad open failed: ${(error as Error).message}`);
    }
  }

  async function updateAmoTheme(next: AmoTheme) {
    await setAmoThemePreference(next);
    setFeedback(`Theme set to ${next === "light" ? "Light" : "Dark"}.`);
  }

  return (
    <main className="utility-window-shell settings-window-shell">
      <section className="app-dialog settings-dialog" role="dialog" aria-label="AMO settings">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <Settings2 size={16} aria-hidden="true" />
            <div>
              <strong>Settings</strong>
              <span>AMO workspace and utility preferences</span>
            </div>
          </div>
          <button
            type="button"
            className="candidate-close"
            title="Close settings"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void closeUtilityWindow("settings");
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <SettingsSidebar settingsSection={settingsSection} onSettingsSectionChange={setSettingsSection} />

        <SettingsDetail
          settingsSection={settingsSection}
          scratchpadShortcut={scratchpadShortcut}
          amoTheme={amoTheme}
          onScratchpadShortcutChange={(next) => void updateScratchpadShortcut(next)}
          onOpenScratchpadNow={() => void openScratchpadNow()}
          onAmoThemeChange={(next) => void updateAmoTheme(next)}
        />

        <footer className="app-dialog-footer">
          <span title={feedback}>{feedback}</span>
        </footer>
      </section>
    </main>
  );
}

export default function App() {
  if (CURRENT_WINDOW_LABEL === "scratchpad") {
    return <ScratchpadApp />;
  }
  if (CURRENT_WINDOW_LABEL === "deploy") {
    return <DeployWorkspaceApp />;
  }
  if (CURRENT_WINDOW_LABEL === "settings") {
    return <SettingsWindowApp />;
  }

  const [amoTheme, setAmoThemePreference] = useAmoThemeRuntime();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [attentionVisualSeen, setAttentionVisualSeen] = useState<Record<string, string>>({});
  const [attentionClock, setAttentionClock] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const [brokerReadiness, setBrokerReadiness] = useState<BrokerReadiness>({
    state: "checking",
    message: "Checking AMO broker",
    detail: "127.0.0.1:17654",
  });
  const [feedback, setFeedback] = useState("Checking AMO broker...");
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<{ sessionId: string; target: "note" | "canvas" } | null>(null);
  const [, setCopyingPromptId] = useState<string | null>(null);
  const [unbindingWindowId, setUnbindingWindowId] = useState<string | null>(null);
  const [reviewingSessionId, setReviewingSessionId] = useState<string | null>(null);
  const [dismissingSessionId, setDismissingSessionId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [sessionSearch, setSessionSearch] = useState("");
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanelState | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState<CleanConfirmState | null>(null);
  const [obsidianVaultRecovery, setObsidianVaultRecovery] = useState<ObsidianVaultRecoveryState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceInspection, setWorkspaceInspection] = useState<WorkspaceInspection | null>(null);
  const [workspaceEnrollment, setWorkspaceEnrollment] = useState<WorkspaceEnrollment | null>(null);
  const [selectedDeployAdapters, setSelectedDeployAdapters] = useState<string[]>([]);
  const [deployBusy, setDeployBusy] = useState<"inspect" | "enroll" | "clean" | null>(null);
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("scratchpad");
  const [scratchpadShortcut, setScratchpadShortcut] = useState<ScratchpadShortcutState>(() =>
    loadScratchpadShortcutState(),
  );
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugCount, setDebugCount] = useState(0);
  const [debugBusy, setDebugBusy] = useState(false);
  const [activeUtilityWindow, setActiveUtilityWindow] = useState<UtilityWindowKind | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sessionsRef = useRef(sessions);
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const debugEnabledRef = useRef(debugEnabled);
  const debugCountRef = useRef(debugCount);
  const cardDragRef = useRef<CardDragState | null>(null);
  const cardDragCleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const dialogRestoreSizeRef = useRef<{ width: number; height: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const autoSyncPromptIdsRef = useRef(new Set<string>());

  const filteredSessions = useMemo(
    () =>
      applySessionOrder(sessions, sessionOrder).filter(
        (session) => sessionMatchesFilter(session, sessionFilter) && sessionMatchesSearch(session, sessionSearch),
      ),
    [sessions, sessionOrder, sessionFilter, sessionSearch],
  );

  const orderedSessions = useMemo(
    () => filteredSessions.slice(0, 8),
    [filteredSessions],
  );

  const attentionCount = useMemo(
    () => sessions.filter((session) => session.needsAttention).length,
    [sessions],
  );

  const reviewCount = useMemo(
    () => sessions.filter(sessionNeedsReview).length,
    [sessions],
  );
  const hasAttentionSignal = useMemo(
    () => sessions.some(sessionHasAttentionSignal),
    [sessions],
  );
  const brokerReady = brokerReadiness.state === "ready";

  useEffect(() => {
    if (!hasAttentionSignal) {
      return undefined;
    }

    setAttentionClock(Date.now());
    const intervalId = window.setInterval(() => setAttentionClock(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [hasAttentionSignal]);

  useEffect(() => {
    setAttentionVisualSeen((previous) => {
      const sessionIds = new Set(sessions.map((session) => session.sessionId));
      let changed = false;
      const next: Record<string, string> = {};

      Object.entries(previous).forEach(([sessionId, attentionKey]) => {
        const session = sessions.find((item) => item.sessionId === sessionId);
        if (sessionIds.has(sessionId) && session && sessionHasAttentionSignal(session) && attentionKey === sessionAttentionKey(session)) {
          next[sessionId] = attentionKey;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [sessions]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    orderedSessionsRef.current = orderedSessions;
  }, [orderedSessions]);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
  }, [debugEnabled]);

  useEffect(() => {
    debugCountRef.current = debugCount;
  }, [debugCount]);

  useEffect(() => {
    void applyScratchpadShortcutState(scratchpadShortcut).catch((error) => {
      setFeedback(`Scratchpad shortcut setup failed: ${(error as Error).message}`);
    });
  }, []);

  useEffect(() => {
    return () => removeCardDragListeners();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<UtilityWindowStateEvent>("amo-utility-window-state", (event) => {
        const payload = event.payload;
        if (!payload?.label) return;
        setActiveUtilityWindow((current) => {
          if (payload.open) {
            return payload.label;
          }
          return current === payload.label ? null : current;
        });
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!activeUtilityWindow) return undefined;

    const label = activeUtilityWindow;
    const sync = () => void syncUtilityWindowState(label);
    const intervalId = window.setInterval(sync, 1200);
    window.addEventListener("focus", sync);
    void syncUtilityWindowState(label);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", sync);
    };
  }, [activeUtilityWindow]);

  async function refreshSessions(reason = "manual") {
    const startedAt = performance.now();
    const shouldLog = reason !== "interval";
    if (shouldLog) {
      void postDebugLog("sessions.refresh.start", {
        reason,
      });
    }

    try {
      const response = await fetch(BROKER_SESSIONS_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }

      const payload = await response.json();
      const nextSessions = normalizeSessions(payload);
      if (!nextSessions) {
        throw new Error("broker response has no sessions");
      }

      const visibleSessions = nextSessions.slice(0, 8);
      setSessions(visibleSessions);
      setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, visibleSessions));
      setBrokerReadiness({
        state: "ready",
        message: "Broker ready",
        detail: `${nextSessions.length} session${nextSessions.length === 1 ? "" : "s"} loaded`,
      });
      setLastRefreshAt(new Date().toISOString());
      setFeedback(nextSessions.length > 0 ? `Broker sessions loaded: ${nextSessions.length}` : "No active broker sessions.");
      if (shouldLog) {
        void postDebugLog("sessions.refresh.ok", {
          reason,
          durationMs: Math.round(performance.now() - startedAt),
          sessionCount: nextSessions.length,
          visibleSessionCount: visibleSessions.length,
        });
      }
    } catch (error) {
      setBrokerReadiness({
        state: "error",
        message: "Broker is not ready",
        detail: (error as Error).message,
      });
      setLastRefreshAt(new Date().toISOString());
      setFeedback(`Broker unavailable: ${(error as Error).message}`);
      if (shouldLog) {
        void postDebugLog("sessions.refresh.error", {
          reason,
          durationMs: Math.round(performance.now() - startedAt),
          message: (error as Error).message,
        });
      }
    }
  }

  async function ensureBrokerThenRefresh() {
    setBrokerReadiness({
      state: "checking",
      message: "Checking AMO broker",
      detail: "127.0.0.1:17654",
    });
    try {
      const result = await invoke<BrokerEnsureResult>("ensure_broker");
      setBrokerReadiness({
        state: result.ok ? (result.started ? "starting" : "checking") : "error",
        message: result.ok ? (result.started ? "Starting AMO broker" : "AMO broker found") : "Broker startup failed",
        detail: result.message,
      });
      setFeedback(result.message);
    } catch (error) {
      setBrokerReadiness({
        state: "error",
        message: "Broker auto-start failed",
        detail: (error as Error).message,
      });
      setFeedback(`Broker auto-start unavailable: ${(error as Error).message}`);
    }

    await refreshSessions("startup");
  }

  async function refreshDebugStatus() {
    try {
      const response = await fetch(BROKER_DEBUG_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }

      const result = (await response.json()) as BrokerDebugStatus;
      const nextEnabled = Boolean(result.enabled);
      const nextCount = result.count ?? 0;
      debugEnabledRef.current = nextEnabled;
      debugCountRef.current = nextCount;
      setDebugEnabled(nextEnabled);
      setDebugCount(nextCount);
    } catch {
      debugEnabledRef.current = false;
      debugCountRef.current = 0;
      setDebugEnabled(false);
      setDebugCount(0);
    }
  }

  async function toggleDebugLogging() {
    const nextEnabled = !debugEnabled;
    setDebugBusy(true);

    try {
      const result = await postBrokerJson<BrokerDebugStatus>(BROKER_DEBUG_URL, {
        enabled: nextEnabled,
      });
      const resultEnabled = Boolean(result.enabled);
      const resultCount = result.count ?? 0;
      debugEnabledRef.current = resultEnabled;
      debugCountRef.current = resultCount;
      setDebugEnabled(resultEnabled);
      setDebugCount(resultCount);
      setFeedback(result.enabled ? "Debug logging enabled." : "Debug logging disabled.");
    } catch (error) {
      setFeedback(`Debug toggle failed: ${(error as Error).message}`);
    } finally {
      setDebugBusy(false);
    }
  }

  async function postDebugLog(event: string, data?: unknown) {
    if (!debugEnabledRef.current) return;

    try {
      const result = await postBrokerJson<{ ok: boolean; count: number }>(BROKER_DEBUG_LOGS_URL, {
        source: "overlay",
        event,
        data: data ?? {},
      });
      setDebugCount(result.count ?? debugCountRef.current);
    } catch {
      // Debug logging must never block the overlay action being debugged.
    }
  }

  function markSessionVisuallySeen(session: AgentSession) {
    if (!sessionHasAttentionSignal(session)) {
      return;
    }

    const attentionKey = sessionAttentionKey(session);
    setAttentionVisualSeen((previous) =>
      previous[session.sessionId] === attentionKey ? previous : { ...previous, [session.sessionId]: attentionKey },
    );
    setAttentionClock(Date.now());
  }

  function isSessionVisuallySeen(session: AgentSession) {
    return attentionVisualSeen[session.sessionId] === sessionAttentionKey(session);
  }

  function isSessionVisualAttentionActive(session: AgentSession) {
    return sessionAttentionVisualActive(session, isSessionVisuallySeen(session), attentionClock);
  }

  async function updateScratchpadShortcut(next: ScratchpadShortcutState) {
    setScratchpadShortcut(next);
    saveScratchpadShortcutState(next);

    try {
      const result = await applyScratchpadShortcutState(next);
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad shortcut update failed: ${(error as Error).message}`);
    }
  }

  async function openScratchpadNow() {
    try {
      const result = await invoke<OpenPathResult>("show_scratchpad_at_cursor");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad open failed: ${(error as Error).message}`);
    }
  }

  async function updateAmoTheme(next: AmoTheme) {
    await setAmoThemePreference(next);
    setFeedback(`Theme set to ${next === "light" ? "Light" : "Dark"}.`);
  }

  async function openCodexAppTarget(session: AgentSession, bindTarget: boolean) {
    const target = codexAppTargetForSession(session);
    const uri = target.uri ?? codexAppThreadUri(session.sessionId);
    markSessionVisuallySeen(session);
    setActivatingId(session.sessionId);
    setCandidateMenu(null);
    setFeedback(`${bindTarget ? "Binding and opening" : "Opening"} Codex App for ${projectName(session.cwd)}...`);
    void postDebugLog("codex_app.target_open.start", {
      sessionId: session.sessionId,
      bindTarget,
      uri,
    });

    try {
      if (bindTarget) {
        const binding = await postBrokerJson<{ ok: boolean; session: AgentSession; targetBinding: TargetBinding }>(
          brokerSessionTargetBindingUrl(session.sessionId),
          target,
        );
        setSessions((previous) =>
          previous.map((item) => (item.sessionId === binding.session.sessionId ? binding.session : item)),
        );
        void postDebugLog("codex_app.target_bound", {
          sessionId: session.sessionId,
          uri,
        });
      }

      const result = await invoke<OpenPathResult>("open_uri", { uri });
      void postDebugLog("codex_app.target_open.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
      });
      setFeedback(result.ok ? "Codex App thread opened." : result.message);
      if (result.ok) {
        void markSessionReviewed(session, "open-codex-app", { quiet: true });
      }
    } catch (error) {
      void postDebugLog("codex_app.target_open.error", {
        sessionId: session.sessionId,
        bindTarget,
        message: (error as Error).message,
      });
      setFeedback(`Open Codex App target failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function openCodexCliTarget(session: AgentSession, bindTarget: boolean) {
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      setFeedback("No workspace path is linked to this card.");
      return;
    }

    const target = codexCliTargetForSession(session);
    markSessionVisuallySeen(session);
    setActivatingId(session.sessionId);
    setCandidateMenu(null);
    setFeedback(`${bindTarget ? "Binding and launching" : "Launching"} Codex CLI resume for ${projectName(workspacePath)}...`);
    void postDebugLog("codex_cli.target_open.start", {
      sessionId: session.sessionId,
      bindTarget,
      workspacePath,
    });

    try {
      if (bindTarget) {
        const binding = await postBrokerJson<{ ok: boolean; session: AgentSession; targetBinding: TargetBinding }>(
          brokerSessionTargetBindingUrl(session.sessionId),
          target,
        );
        setSessions((previous) =>
          previous.map((item) => (item.sessionId === binding.session.sessionId ? binding.session : item)),
        );
        void postDebugLog("codex_cli.target_bound", {
          sessionId: session.sessionId,
          workspacePath,
        });
      }

      const result = await postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, {
        workspacePath,
        adapterId: "codex-cli",
        sessionId: session.sessionId,
      });
      void postDebugLog("codex_cli.target_open.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        pid: result.pid ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      void postDebugLog("codex_cli.target_open.error", {
        sessionId: session.sessionId,
        bindTarget,
        workspacePath,
        message: (error as Error).message,
      });
      setFeedback(`Open Codex CLI target failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  function openCodexTargetMenu(session: AgentSession, menuX?: number, menuY?: number, candidates?: ActivationCandidate[]) {
    const position = menuPosition(menuX, menuY);
    const hintCandidate = activationCandidateFromWindowTarget(windowTargetForSession(session));
    const mergedCandidates = [...(candidates ?? [])];
    if (hintCandidate && !mergedCandidates.some((candidate) => candidate.hwnd === hintCandidate.hwnd && candidate.processId === hintCandidate.processId)) {
      mergedCandidates.unshift(hintCandidate);
    }

    setCandidateMenu({
      session,
      candidates: mergedCandidates,
      x: position.x,
      y: position.y,
      bindOnSelect: true,
      codexAppAvailable: true,
      codexCliResumeAvailable: Boolean(workspacePathForSession(session)),
    });
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
      });
      void postDebugLog("workspace.inspect.ok", {
        workspacePath: result.workspacePath,
        projectName: result.projectName,
        adapters: result.supportedAdapters.map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
          deploymentStatus: adapter.deploymentStatus,
          workspaceState: adapter.workspaceState,
          deployable: adapter.deployable,
          recommended: adapter.recommended,
          confidence: adapter.confidence,
        })),
      });
      setWorkspaceInspection(result);
      setWorkspacePath(result.workspacePath);
      const availableAdapters = result.supportedAdapters
        .filter((adapter) => isDeployableWorkspaceAdapter(adapter) && adapter.recommended !== false)
        .map((adapter) => adapter.id);
      setSelectedDeployAdapters(availableAdapters);
      const deployableCount = result.supportedAdapters.filter(isDeployableWorkspaceAdapter).length;
      setFeedback(`${result.projectName}: ${deployableCount} deployable adapter(s), ${availableAdapters.length} selected.`);
    } catch (error) {
      void postDebugLog("workspace.inspect.error", {
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
      const result = await invoke<FolderPickResult>("select_workspace_directory");
      if (!result.ok || !result.path) {
        setFeedback(result.message);
        return;
      }

      await openDeployDialog();
      setWorkspacePath(result.path);
      setWorkspaceInspection(null);
      setWorkspaceEnrollment(null);
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
      setSelectedDeployAdapters([]);
    }
  }

  async function enrollWorkspace() {
    const targetPath = workspaceInspection?.workspacePath ?? workspacePath.trim();
    if (!targetPath) {
      setFeedback("Workspace path is required.");
      return;
    }

    setDeployBusy("enroll");
    setFeedback("Deploying workspace adapter...");

    try {
      const adapters =
        selectedDeployAdapters.length > 0
          ? selectedDeployAdapters
          : (workspaceInspection?.supportedAdapters || [])
              .filter(isDeployableWorkspaceAdapter)
              .map((adapter) => adapter.id);
      if (adapters.length === 0) {
        setFeedback("No deployable adapter selected.");
        return;
      }
      const result = await postBrokerJson<WorkspaceEnrollment>(BROKER_WORKSPACE_ENROLL_URL, {
        workspacePath: targetPath,
        adapters,
      });
      void postDebugLog("workspace.enroll.ok", {
        workspacePath: result.workspacePath,
        vaultRoot: result.vaultRoot,
        installedAdapters: result.installedAdapters,
      });
      setWorkspaceEnrollment(result);
      setFeedback(`Deployed ${result.installedAdapters.join(", ")} for ${projectName(result.workspacePath)}. ${OBSIDIAN_PLUGIN_RELOAD_HINT}`);
      void refreshSessions("workspace-enroll");
    } catch (error) {
      void postDebugLog("workspace.enroll.error", {
        workspacePath: targetPath,
        message: (error as Error).message,
      });
      setFeedback(`Deploy failed: ${(error as Error).message}`);
    } finally {
      setDeployBusy(null);
    }
  }

  async function clearWorkspaceGeneratedFromDeploy() {
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
      void postDebugLog("workspace.deploy.clean.ok", {
        workspacePath: result.workspacePath,
        generatedNotes: workspaceGeneratedNoteCount(result.before),
        canvasNodes: result.before.counts.canvasNodes,
        clearedSessions: result.clearedSessions,
      });
      const refreshed = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath: result.workspacePath,
      });
      setWorkspaceInspection(refreshed);
      setWorkspacePath(refreshed.workspacePath);
      setSelectedDeployAdapters(selectedWorkspaceAdapterIds(refreshed));
      setFeedback(workspaceCleanFeedback(result));
      void refreshSessions("workspace-clean");
    } catch (error) {
      void postDebugLog("workspace.deploy.clean.error", {
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
    void postDebugLog("workspace.launch.start", {
      workspacePath: targetPath,
      adapterId,
    });

    try {
      const result = await postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, {
        workspacePath: targetPath,
        adapterId,
      });
      void postDebugLog("workspace.launch.ok", {
        workspacePath: result.workspacePath,
        adapterId: result.adapterId,
        pid: result.pid ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      void postDebugLog("workspace.launch.error", {
        workspacePath: targetPath,
        adapterId,
        message: (error as Error).message,
      });
      setFeedback(`Launch failed: ${(error as Error).message}`);
    } finally {
      setLaunchBusy(null);
    }
  }

  async function openWorkspacePanel(session: AgentSession, x?: number, y?: number) {
    const position = workspacePanelPosition(x, y);
    setCandidateMenu(null);
    setWorkspacePanel({
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

  async function loadWorkspaceStatus(session: AgentSession) {
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      setWorkspacePanel((current) =>
        current ? { ...current, busy: null, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    setWorkspacePanel((current) => (current ? { ...current, busy: "status", error: null } : current));
    try {
      const status = await postBrokerJson<WorkspaceMaintenanceStatus>(BROKER_WORKSPACE_STATUS_URL, {
        workspacePath,
      });
      setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? {
              ...current,
              status,
              busy: null,
              error: null,
            }
          : current,
      );
      void postDebugLog("workspace.maintenance.status.ok", {
        sessionId: session.sessionId,
        workspacePath,
        issueCount: status.issues.length,
      });
    } catch (error) {
      const message = (error as Error).message;
      setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      void postDebugLog("workspace.maintenance.status.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  async function cleanWorkspaceVaultFromPanel() {
    if (!workspacePanel) return;
    const session = workspacePanel.session;
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    setCleanConfirm(null);
    setWorkspacePanel((current) => (current ? { ...current, busy: "clean", error: null } : current));
    setFeedback(`Cleaning AMO notes for ${projectName(workspacePath)}...`);
    try {
      const result = await postBrokerJson<WorkspaceCleanResult>(BROKER_WORKSPACE_CLEAN_VAULT_URL, {
        workspacePath,
      });
      setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? {
              ...current,
              status: result.after,
              busy: null,
              error: null,
            }
          : current,
      );
      setFeedback(workspaceCleanFeedback(result));
      void postDebugLog("workspace.maintenance.clean.ok", {
        sessionId: session.sessionId,
        workspacePath,
        clearedSessions: result.clearedSessions,
      });
      void refreshSessions("workspace-clean");
    } catch (error) {
      const message = (error as Error).message;
      setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      setFeedback(`Clean failed: ${message}`);
      void postDebugLog("workspace.maintenance.clean.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  function requestCleanWorkspaceVault() {
    if (!workspacePanel) return;
    const workspacePath = workspacePathForSession(workspacePanel.session);
    if (!workspacePath) {
      setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    setCleanConfirm({
      session: workspacePanel.session,
      workspacePath,
      replyNotes: workspacePanel.status?.counts.replyNotes ?? 0,
      promptNotes: workspacePanel.status?.counts.promptNotes ?? 0,
      canvasNodes: workspacePanel.status?.counts.canvasNodes ?? 0,
    });
  }

  async function openMaintenancePath(path: string | undefined, label: string) {
    if (!path) return;
    setWorkspacePanel((current) => (current ? { ...current, busy: "open", error: null } : current));
    try {
      const result = await invoke<OpenPathResult>("open_path", { path });
      setFeedback(result.ok ? `Opened ${label}.` : result.message);
      if (!result.ok) {
        setWorkspacePanel((current) => (current ? { ...current, error: result.message } : current));
      }
    } catch (error) {
      const message = (error as Error).message;
      setFeedback(`Open ${label} failed: ${message}`);
      setWorkspacePanel((current) => (current ? { ...current, error: message } : current));
    } finally {
      setWorkspacePanel((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function saveWorkspacePanelTaskTitle(overrideTaskTitle?: string) {
    if (!workspacePanel) return;

    const sessionId = workspacePanel.session.sessionId;
    const nextTaskTitle = (overrideTaskTitle ?? workspacePanel.taskTitleDraft).trim();
    setWorkspacePanel((current) => (current ? { ...current, busy: "task-title", error: null } : current));
    setFeedback(nextTaskTitle ? `Saving task name: ${nextTaskTitle}` : "Clearing task name...");
    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionTaskTitleUrl(sessionId),
        { taskTitle: nextTaskTitle },
      );
      setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      setWorkspacePanel((current) =>
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
      setFeedback(nextTaskTitle ? "Task name saved." : "Task name cleared.");
      void postDebugLog("session.task_title.save.ok", {
        sessionId,
        hasTaskTitle: Boolean(nextTaskTitle),
      });
    } catch (error) {
      const message = (error as Error).message;
      setWorkspacePanel((current) =>
        current && current.session.sessionId === sessionId ? { ...current, busy: null, error: message } : current,
      );
      setFeedback(`Task name save failed: ${message}`);
      void postDebugLog("session.task_title.save.error", {
        sessionId,
        message,
      });
    }
  }

  async function toggleCollapsed() {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);

    try {
      await getCurrentWindow().setSize(
        nextCollapsed
          ? new LogicalSize(COLLAPSED_OVERLAY_SIZE.width, COLLAPSED_OVERLAY_SIZE.height)
          : new LogicalSize(DEFAULT_OVERLAY_SIZE.width, DEFAULT_OVERLAY_SIZE.height),
      );
    } catch {
      // Browser preview cannot resize a native window.
    }
  }

  function startDialogDrag(event: PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, select, textarea, label")) {
      return;
    }

    void getCurrentWindow().startDragging().catch(() => undefined);
  }

  async function expandForDialog(kind: keyof typeof DIALOG_SIZES) {
    if (!dialogRestoreSizeRef.current) {
      try {
        const size = await getCurrentWindow().innerSize();
        dialogRestoreSizeRef.current = collapsed
          ? { ...DEFAULT_OVERLAY_SIZE }
          : { width: Math.max(size.width, DEFAULT_OVERLAY_SIZE.width), height: Math.max(size.height, DEFAULT_OVERLAY_SIZE.height) };
      } catch {
        dialogRestoreSizeRef.current = { ...DEFAULT_OVERLAY_SIZE };
      }
    }

    setCollapsed(false);
    const nextSize = DIALOG_SIZES[kind];
    try {
      await getCurrentWindow().setSize(new LogicalSize(nextSize.width, nextSize.height));
    } catch {
      // Browser preview cannot resize a native window.
    }
  }

  async function restoreAfterDialogClose() {
    const restoreSize = dialogRestoreSizeRef.current;
    dialogRestoreSizeRef.current = null;
    if (!restoreSize) return;

    try {
      await getCurrentWindow().setSize(new LogicalSize(restoreSize.width, restoreSize.height));
    } catch {
      // Browser preview cannot resize a native window.
    }
  }

  async function openDeployDialog() {
    await openUtilityWindow("deploy");
  }

  async function closeDeployDialog() {
    await hideUtilityWindow("deploy");
  }

  async function openSettingsDialog(section: SettingsSection = "scratchpad") {
    setSettingsSection(section);
    await openUtilityWindow("settings");
  }

  async function closeSettingsDialog() {
    await hideUtilityWindow("settings");
  }

  async function openUtilityWindow(label: UtilityWindowKind) {
    setDeployOpen(false);
    setSettingsOpen(false);
    setActiveUtilityWindow(label);

    try {
      const otherLabel: UtilityWindowKind = label === "deploy" ? "settings" : "deploy";
      const otherWindow = await WebviewWindow.getByLabel(otherLabel);
      await otherWindow?.hide();
      await setAmoWindowAlwaysOnTop(otherLabel, false);

      const targetWindow = await WebviewWindow.getByLabel(label);
      if (!targetWindow) {
        throw new Error(`${label} window is not registered`);
      }
      await bringUtilityWindowToFront(label);
      setFeedback(`${label === "deploy" ? "Deploy Workspace" : "Settings"} opened.`);
    } catch (error) {
      setActiveUtilityWindow(null);
      setFeedback(`Open ${label} window failed: ${(error as Error).message}`);
    }
  }

  async function hideUtilityWindow(label: UtilityWindowKind) {
    try {
      const targetWindow = await WebviewWindow.getByLabel(label);
      await targetWindow?.hide();
      await setAmoWindowAlwaysOnTop(label, false);
      await setAmoWindowAlwaysOnTop("main", true);
    } catch {
      // A missing utility window should still unblock the main window.
    } finally {
      setActiveUtilityWindow((current) => (current === label ? null : current));
    }
  }

  async function focusUtilityWindow(label: UtilityWindowKind) {
    try {
      await bringUtilityWindowToFront(label);
    } catch (error) {
      setActiveUtilityWindow(null);
      setFeedback(`Focus ${label} window failed: ${(error as Error).message}`);
    }
  }

  async function syncUtilityWindowState(label: UtilityWindowKind) {
    try {
      const targetWindow = await WebviewWindow.getByLabel(label);
      const visible = targetWindow ? await targetWindow.isVisible() : false;
      if (!visible) {
        setActiveUtilityWindow((current) => (current === label ? null : current));
        await setAmoWindowAlwaysOnTop("main", true);
      }
    } catch {
      setActiveUtilityWindow((current) => (current === label ? null : current));
      await setAmoWindowAlwaysOnTop("main", true);
    }
  }

  async function activateSession(session: AgentSession, menuX?: number, menuY?: number) {
    markSessionVisuallySeen(session);
    const targetBinding = targetBindingForSession(session);
    if (!targetBinding && isCodexSession(session)) {
      openCodexTargetMenu(session, menuX, menuY);
      return;
    }

    if (targetBinding?.type === "codex-app-thread") {
      await openCodexAppTarget(session, false);
      return;
    }
    if (targetBinding?.type === "codex-cli-session") {
      await openCodexCliTarget(session, false);
      return;
    }

    const activationTarget = activationTargetForSession(session);
    setActivatingId(session.sessionId);
    setCandidateMenu(null);
    setFeedback(`Activating ${activationTarget?.label ?? session.title}...`);
    void postDebugLog("window.activate.start", {
      sessionId: session.sessionId,
      title: session.title,
      targetType: activationTarget?.type ?? "auto",
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
      cwd: session.cwd,
    });

    try {
      const result = await invoke<ActivationResult>("activate_session_window", {
        sessionId: session.sessionId,
        tool: session.tool,
        title: activationTarget?.type === "window" ? activationTarget.title ?? session.windowHint?.title ?? session.title : session.windowHint?.title ?? session.title,
        processName:
          activationTarget?.type === "window"
            ? activationTarget.processName ?? session.windowHint?.process ?? ""
            : session.windowHint?.process ?? "",
        titleToken: session.windowHint?.titleToken ?? "",
        titleContains: session.windowHint?.titleContains ?? [],
        project: session.windowHint?.project ?? projectName(session.cwd),
        cwd: session.windowHint?.cwd ?? session.cwd,
        pid: activationTarget?.type === "window" ? activationTarget.processId ?? session.windowHint?.pid ?? null : session.windowHint?.pid ?? null,
        hwnd: activationTarget?.type === "window" ? activationTarget.hwnd ?? session.windowHint?.hwnd ?? null : session.windowHint?.hwnd ?? null,
      });
      if (!result.ok && ((result.candidates?.length ?? 0) > 0 || isCodexSession(session))) {
        if (isCodexSession(session)) {
          openCodexTargetMenu(session, menuX, menuY, result.candidates ?? []);
        } else {
          const position = menuPosition(menuX, menuY);
          setCandidateMenu({
            session,
            candidates: result.candidates ?? [],
            x: position.x,
            y: position.y,
            bindOnSelect: true,
            codexAppAvailable: false,
            codexCliResumeAvailable: false,
          });
        }
      }
      void postDebugLog("window.activate.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        candidateCount: result.candidates?.length ?? 0,
      });
      setFeedback(result.message);
    } catch (error) {
      void postDebugLog("window.activate.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      setFeedback(`Activation command failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  function showObsidianVaultRecovery(
    session: AgentSession,
    target: "note" | "canvas",
    targetPath: string,
    focusNotePath: string | null,
    registration: ObsidianVaultRegistrationResult,
    message: string,
  ) {
    setObsidianVaultRecovery({
      session,
      target,
      targetPath,
      focusNotePath,
      vaultRoot: registration.vaultRoot,
      vaultId: registration.vaultId,
      runtimeConfigPath: registration.runtimeConfigPath ?? null,
      obsidianProcessCount: registration.obsidianProcessCount ?? null,
      busy: null,
    });
    setFeedback(message);
  }

  async function openRecoveryVaultFolder() {
    if (!obsidianVaultRecovery) return;
    setObsidianVaultRecovery((current) => (current ? { ...current, busy: "explorer" } : current));

    try {
      const result = await invoke<OpenPathResult>("open_path", { path: obsidianVaultRecovery.vaultRoot });
      setFeedback(result.ok ? "Opened AMO vault folder." : result.message);
    } catch (error) {
      setFeedback(`Open AMO vault folder failed: ${(error as Error).message}`);
    } finally {
      setObsidianVaultRecovery((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function copyRecoveryVaultPath() {
    if (!obsidianVaultRecovery) return;
    setObsidianVaultRecovery((current) => (current ? { ...current, busy: "copy" } : current));

    try {
      const result = await invoke<OpenPathResult>("write_clipboard_text", {
        text: obsidianVaultRecovery.vaultRoot,
      });
      setFeedback(result.ok ? "Copied AMO vault path." : result.message);
    } catch (error) {
      setFeedback(`Copy AMO vault path failed: ${(error as Error).message}`);
    } finally {
      setObsidianVaultRecovery((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function openBridgePath(session: AgentSession, target: "note" | "canvas") {
    const targetPath = target === "note" ? notePathForOpen(session) : canvasPathForOpen(session);
    const focusNotePath = target === "canvas" ? latestCanvasNotePathForFocus(session) : null;
    if (!targetPath) {
      setFeedback(`No ${target} path is linked for ${session.title}.`);
      return;
    }

    markSessionVisuallySeen(session);
    setOpeningPath({ sessionId: session.sessionId, target });
    setFeedback(`Opening ${target} for ${session.title}...`);
    void postDebugLog("obsidian.open.start", {
      sessionId: session.sessionId,
      target,
      targetPath,
      focusNotePath,
      vaultRoot: session.vaultRoot ?? null,
      vaultId: null,
    });

    try {
      let vaultId: string | undefined;
      let registration: ObsidianVaultRegistrationResult | null = null;
      if (session.vaultRoot) {
        registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
          BROKER_OBSIDIAN_REGISTER_VAULT_URL,
          { vaultRoot: session.vaultRoot }
        );
        vaultId = registration.vaultId;
        void postDebugLog("obsidian.open.vault_registered", {
          sessionId: session.sessionId,
          target,
          vaultRoot: session.vaultRoot,
          vaultId,
          changed: registration.changed,
          runtimeConfigExists: registration.runtimeConfigExists ?? null,
          runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
          vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
          runtimeConfigPath: registration.runtimeConfigPath ?? null,
          obsidianProcessCount: registration.obsidianProcessCount ?? null,
        });
      }

      const bootstrapUri = vaultId ? obsidianOpenUri(targetPath, vaultId, session.vaultRoot) : null;
      let bootstrapResult: OpenPathResult | null = null;
      const needsRuntimeBootstrap = Boolean(registration && !registration.runtimeConfigExists);
      if (registration && needsRuntimeBootstrap && (registration.obsidianProcessCount ?? 0) > 0) {
        const message =
          "Obsidian has not loaded this AMO vault yet. Open this folder as a vault in Obsidian once, then try again.";
        void postDebugLog("obsidian.open.runtime_missing", {
          sessionId: session.sessionId,
          target,
          vaultRoot: session.vaultRoot,
          vaultId: registration.vaultId,
          runtimeConfigPath: registration.runtimeConfigPath ?? null,
          runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
          vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
          obsidianProcessCount: registration.obsidianProcessCount ?? null,
          skippedBootstrap: true,
        });
        showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
        setFeedback(message);
        return;
      }

      if (bootstrapUri && needsRuntimeBootstrap) {
        void postDebugLog("obsidian.open.bootstrap_uri", {
          sessionId: session.sessionId,
          target,
          uri: bootstrapUri,
          vaultId,
        });
        bootstrapResult = await invoke<OpenPathResult>("open_uri", { uri: bootstrapUri });
        void postDebugLog("obsidian.open.bootstrap_result", {
          sessionId: session.sessionId,
          target,
          ok: bootstrapResult.ok,
          message: bootstrapResult.message,
        });
        if (!bootstrapResult.ok) {
          setFeedback(bootstrapResult.message);
          return;
        }

        await sleep(OBSIDIAN_PLUGIN_BOOTSTRAP_DELAY_MS);
        if (registration && needsRuntimeBootstrap && session.vaultRoot) {
          registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
            BROKER_OBSIDIAN_REGISTER_VAULT_URL,
            { vaultRoot: session.vaultRoot }
          );
          void postDebugLog("obsidian.open.runtime_check", {
            sessionId: session.sessionId,
            target,
            vaultRoot: session.vaultRoot,
            vaultId: registration.vaultId,
            runtimeConfigExists: registration.runtimeConfigExists ?? null,
            runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
            vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
            runtimeConfigPath: registration.runtimeConfigPath ?? null,
            obsidianProcessCount: registration.obsidianProcessCount ?? null,
          });
          if (!registration.runtimeConfigExists) {
            const message =
              "Obsidian accepted the open request, but this AMO vault is still not loaded. Open this folder as a vault in Obsidian once, then try again.";
            void postDebugLog("obsidian.open.runtime_missing", {
              sessionId: session.sessionId,
              target,
              vaultRoot: session.vaultRoot,
              vaultId: registration.vaultId,
              runtimeConfigPath: registration.runtimeConfigPath ?? null,
              runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
              vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
              obsidianProcessCount: registration.obsidianProcessCount ?? null,
              skippedBootstrap: false,
            });
            showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
            setFeedback(message);
            return;
          }
        }
      }

      const uri = obsidianAmoOpenUri(targetPath, target, vaultId, session.vaultRoot, { focusNotePath });
      void postDebugLog("obsidian.open.uri", {
        sessionId: session.sessionId,
        target,
        uri,
        vaultId: vaultId ?? null,
        bootstrapUsed: Boolean(bootstrapResult),
        pluginOpenSkipped: false,
      });
      const result = await invoke<OpenPathResult>("open_uri", { uri });
      void postDebugLog("obsidian.open.result", {
        sessionId: session.sessionId,
        target,
        focusNotePath,
        ok: result.ok,
        message: result.message,
        bootstrapUsed: Boolean(bootstrapResult),
        pluginOpenSkipped: false,
      });
      if (result.ok) {
        setFeedback(`${target === "note" ? "Note" : "Canvas"} opened in Obsidian.`);
        void markSessionReviewed(session, `open-${target}`, { quiet: true });
      } else {
        setFeedback(result.message);
      }
    } catch (error) {
      void postDebugLog("obsidian.open.error", {
        sessionId: session.sessionId,
        target,
        targetPath,
        message: (error as Error).message,
      });
      setFeedback(`Open ${target} failed: ${(error as Error).message}`);
    } finally {
      setOpeningPath(null);
    }
  }

  async function copyPendingPrompt(session: AgentSession) {
    if (!session.pendingPrompt) {
      setFeedback(`No pending prompt is linked for ${session.title}.`);
      return;
    }

    setCopyingPromptId(session.sessionId);
    setFeedback(`Copying pending prompt for ${session.title}...`);
    const clipboardPrompt = clipboardPromptForSession(session);
    const clipboardMode = targetBindingForSession(session)?.type === "codex-app-thread" ? "raw" : "cli-safe";
    void postDebugLog("sync.copy.start", {
      sessionId: session.sessionId,
      pendingPromptId: session.pendingPromptId ?? null,
      promptLength: session.pendingPrompt.length,
      clipboardLength: clipboardPrompt.length,
      clipboardMode,
      hasWindowBinding: Boolean(session.windowHint?.hwnd || session.windowHint?.pid),
      targetType: targetBindingForSession(session)?.type ?? "auto",
    });

    try {
      const result = await invoke<OpenPathResult>("write_clipboard_text", { text: clipboardPrompt });
      if (!result.ok) {
        void postDebugLog("sync.copy.clipboard_failed", {
          sessionId: session.sessionId,
          message: result.message,
        });
        setFeedback(result.message);
        return;
      }
      void postDebugLog("sync.copy.clipboard_ok", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
      });

      const response = await fetch(BROKER_SYNC_BACK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          pendingPromptId: session.pendingPromptId ?? null,
          action: "copy-focus",
        }),
      });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }
      const syncResult = (await response.json()) as {
        promptNotePath?: string | null;
        promptCanvasNodeId?: string | null;
      };

      void postDebugLog("sync.copy.broker_ok", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        promptNotePath: syncResult.promptNotePath ?? null,
        promptCanvasNodeId: syncResult.promptCanvasNodeId ?? null,
      });
      setFeedback("Pending prompt copied. Focusing target...");
      void refreshSessions("sync-copy");
      await activateSession(session);
    } catch (error) {
      void postDebugLog("sync.copy.error", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        message: (error as Error).message,
      });
      setFeedback(`Copy + focus failed: ${(error as Error).message}`);
    } finally {
      setCopyingPromptId(null);
    }
  }

  function autoCopyAndFocusPendingPrompt(session: AgentSession, reason: string) {
    if (!session.pendingPrompt) {
      return;
    }

    const autoSyncKey =
      session.pendingPromptId ||
      `${session.sessionId}:${session.pendingPromptCreatedAt || session.updatedAt || session.pendingPrompt.slice(0, 48)}`;
    if (autoSyncPromptIdsRef.current.has(autoSyncKey)) {
      void postDebugLog("sync.auto_copy.skip_duplicate", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        reason,
      });
      return;
    }

    autoSyncPromptIdsRef.current.add(autoSyncKey);
    void postDebugLog("sync.auto_copy.start", {
      sessionId: session.sessionId,
      pendingPromptId: session.pendingPromptId ?? null,
      reason,
      promptLength: session.pendingPrompt.length,
    });
    void copyPendingPrompt(session);
  }

  async function activateCandidate(session: AgentSession, candidate: ActivationCandidate, bindWindow: boolean) {
    markSessionVisuallySeen(session);
    setActivatingId(session.sessionId);
    setFeedback(`Activating ${candidate.processName ?? "window"}...`);
    void postDebugLog("window.candidate.activate.start", {
      sessionId: session.sessionId,
      hwnd: candidate.hwnd,
      processId: candidate.processId,
      processName: candidate.processName ?? null,
      bindWindow,
    });

    try {
      const result = await invoke<ActivationResult>("activate_session_window", {
        sessionId: session.sessionId,
        tool: session.tool,
        title: candidate.title,
        processName: candidate.processName ?? "",
        titleToken: "",
        titleContains: [],
        project: "",
        cwd: session.cwd,
        pid: candidate.processId,
        hwnd: candidate.hwnd,
      });
      setFeedback(result.message);
      void postDebugLog("window.candidate.activate.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        bindWindow,
      });
      if (result.ok) {
        if (bindWindow) {
          const binding = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
            brokerSessionTargetBindingUrl(session.sessionId),
            {
              type: "window",
              hwnd: candidate.hwnd,
              processId: candidate.processId,
              processName: candidate.processName ?? null,
              title: candidate.title,
              label: candidate.label,
            },
          );
          void postDebugLog("window.candidate.bound", {
            sessionId: session.sessionId,
            hwnd: candidate.hwnd,
            processId: candidate.processId,
            processName: candidate.processName ?? null,
          });
          setSessions((previous) =>
            previous.map((item) => (item.sessionId === binding.session.sessionId ? binding.session : item)),
          );
          setFeedback(`Bound and activated ${candidate.processName ?? "window"}.`);
        }
        setCandidateMenu(null);
        void markSessionReviewed(session, "activate-candidate", { quiet: true });
      }
    } catch (error) {
      void postDebugLog("window.candidate.activate.error", {
        sessionId: session.sessionId,
        hwnd: candidate.hwnd,
        processId: candidate.processId,
        message: (error as Error).message,
      });
      setFeedback(`Candidate activation failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function clearWindowBinding(session: AgentSession) {
    setUnbindingWindowId(session.sessionId);
    setFeedback(`Clearing target binding for ${session.title}...`);
    void postDebugLog("window.unbind.start", {
      sessionId: session.sessionId,
      targetType: targetBindingForSession(session)?.type ?? "auto",
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionTargetBindingClearUrl(session.sessionId),
        {},
      );
      setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      void postDebugLog("window.unbind.ok", {
        sessionId: session.sessionId,
      });
      setFeedback("Target binding cleared.");
      void refreshSessions("target-unbind");
    } catch (error) {
      void postDebugLog("window.unbind.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      setFeedback(`Unbind failed: ${(error as Error).message}`);
    } finally {
      setUnbindingWindowId(null);
    }
  }

  async function markSessionReviewed(
    session: AgentSession,
    action = "manual",
    options: { quiet?: boolean } = {},
  ) {
    markSessionVisuallySeen(session);
    if (!sessionNeedsReview(session)) {
      return;
    }

    setReviewingSessionId(session.sessionId);
    if (!options.quiet) {
      setFeedback(`Marking ${session.title} as reviewed...`);
    }
    void postDebugLog("session.review.start", {
      sessionId: session.sessionId,
      action,
      reviewTurnId: session.reviewTurnId ?? null,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionReviewedUrl(session.sessionId),
        { action, by: "overlay" },
      );
      setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      if (!options.quiet) {
        setFeedback("Marked as reviewed.");
      }
      void postDebugLog("session.review.ok", {
        sessionId: result.session.sessionId,
        action,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (!options.quiet) {
        setFeedback(`Review mark failed: ${message}`);
      }
      void postDebugLog("session.review.error", {
        sessionId: session.sessionId,
        action,
        message,
      });
    } finally {
      setReviewingSessionId(null);
    }
  }

  async function dismissSession(session: AgentSession) {
    setDismissingSessionId(session.sessionId);
    setFeedback(`Dismissing ${session.title}...`);
    void postDebugLog("session.dismiss.start", {
      sessionId: session.sessionId,
      title: session.title,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; sessionId: string }>(
        brokerSessionDismissUrl(session.sessionId),
        { reason: "user" },
      );
      const dismissedSessionId = result.sessionId || session.sessionId;
      setSessions((previous) => previous.filter((item) => item.sessionId !== dismissedSessionId));
      setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => sessionId !== dismissedSessionId));
      setCandidateMenu((current) =>
        current?.session.sessionId === dismissedSessionId ? null : current,
      );
      setWorkspacePanel((current) =>
        current?.session.sessionId === dismissedSessionId ? null : current,
      );
      setFeedback(`Dismissed ${session.title}.`);
      void postDebugLog("session.dismiss.ok", {
        sessionId: dismissedSessionId,
      });
    } catch (error) {
      const message = (error as Error).message;
      setFeedback(`Dismiss failed: ${message}`);
      void postDebugLog("session.dismiss.error", {
        sessionId: session.sessionId,
        message,
      });
    } finally {
      setDismissingSessionId(null);
    }
  }

  function moveDraggedSessionToIndex(draggingSessionId: string, targetIndex: number) {
    setSessionOrder((previousOrder) => {
      const currentSessions = sessionsRef.current;
      const orderedVisibleIds = orderedSessionsRef.current.map((session) => session.sessionId);
      const visibleWithoutDragged = orderedVisibleIds.filter((sessionId) => sessionId !== draggingSessionId);
      const baseOrder = mergeSessionOrder(previousOrder, currentSessions).filter(
        (sessionId) => sessionId !== draggingSessionId,
      );

      const beforeId = visibleWithoutDragged[targetIndex] ?? null;
      const afterId = targetIndex > 0 ? visibleWithoutDragged[targetIndex - 1] : null;
      const insertIndex = beforeId
        ? baseOrder.indexOf(beforeId)
        : afterId
          ? baseOrder.indexOf(afterId) + 1
          : baseOrder.length;

      const safeIndex = Math.max(0, Math.min(insertIndex, baseOrder.length));
      const nextOrder = [...baseOrder];
      nextOrder.splice(safeIndex, 0, draggingSessionId);

      if (nextOrder.join("\u0000") === mergeSessionOrder(previousOrder, currentSessions).join("\u0000")) {
        return previousOrder;
      }

      return nextOrder;
    });
  }

  function updateCardDrag(pointerY: number) {
    const activeDrag = cardDragRef.current;
    if (!activeDrag) {
      return;
    }

    const visibleTargets = orderedSessionsRef.current.filter(
      (session) => session.sessionId !== activeDrag.sessionId,
    );
    let targetIndex = visibleTargets.length;
    let nextDropTargetId: string | null = null;

    for (let index = 0; index < visibleTargets.length; index += 1) {
      const targetSession = visibleTargets[index];
      const targetElement = rowRefs.current.get(targetSession.sessionId);
      if (!targetElement) {
        continue;
      }

      const rect = targetElement.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        targetIndex = index;
        nextDropTargetId = targetSession.sessionId;
        break;
      }

      nextDropTargetId = targetSession.sessionId;
    }

    setDropTargetId(nextDropTargetId);
    moveDraggedSessionToIndex(activeDrag.sessionId, targetIndex);
  }

  function startCardDrag(session: AgentSession, event: PointerEvent<HTMLElement>) {
    const row = rowRefs.current.get(session.sessionId);
    if (!row) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the handle is remounted during a reorder.
    }

    const rect = row.getBoundingClientRect();
    const nextDrag = {
      sessionId: session.sessionId,
      pointerId: event.pointerId,
      pointerY: event.clientY,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
    cardDragRef.current = nextDrag;
    suppressNextClickRef.current = true;
    setCardDrag(nextDrag);
    setDropTargetId(null);
    setFeedback(`Dragging ${session.title}.`);
    attachCardDragListeners(event.pointerId);
  }

  function attachCardDragListeners(pointerId: number) {
    removeCardDragListeners();

    const handleMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      continueCardDragAt(event.clientY);
    };

    const handleEnd = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      finishCardDrag();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd, { passive: false });
    window.addEventListener("pointercancel", handleEnd, { passive: false });
    cardDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  }

  function removeCardDragListeners() {
    cardDragCleanupRef.current?.();
    cardDragCleanupRef.current = null;
  }

  function continueCardDragAt(pointerY: number) {
    const activeDrag = cardDragRef.current;
    if (!activeDrag) {
      return;
    }

    const nextDrag = {
      ...activeDrag,
      pointerY,
    };
    cardDragRef.current = nextDrag;
    setCardDrag(nextDrag);
    updateCardDrag(pointerY);
  }

  function finishCardDrag() {
    if (!cardDragRef.current) {
      return;
    }

    removeCardDragListeners();
    cardDragRef.current = null;
    setCardDrag(null);
    setDropTargetId(null);
  }

  function endCardDrag(event: PointerEvent<HTMLElement>) {
    if (!cardDragRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    finishCardDrag();
  }

  async function startWindowResize(event: PointerEvent<HTMLElement>, mode: ResizeState["mode"]) {
    if (collapsed) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    try {
      const size = await getCurrentWindow().innerSize();
      resizeRef.current = {
        mode,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startWidth: size.width,
        startHeight: size.height,
      };
      setIsResizing(true);
      setFeedback("Resizing overlay.");
    } catch {
      resizeRef.current = null;
      setIsResizing(false);
    }
  }

  function continueWindowResize(event: PointerEvent<HTMLElement>) {
    const activeResize = resizeRef.current;
    if (!activeResize) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextWidth =
      activeResize.mode === "vertical"
        ? activeResize.startWidth
        : Math.max(320, Math.min(900, activeResize.startWidth + event.screenX - activeResize.startScreenX));
    const nextHeight =
      activeResize.mode === "horizontal"
        ? activeResize.startHeight
        : Math.max(280, Math.min(900, activeResize.startHeight + event.screenY - activeResize.startScreenY));

    void getCurrentWindow().setSize(new LogicalSize(nextWidth, nextHeight)).catch(() => undefined);
  }

  function endWindowResize(event: PointerEvent<HTMLElement>) {
    if (!resizeRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    setIsResizing(false);
  }

  useEffect(() => {
    void ensureBrokerThenRefresh().finally(() => {
      void refreshDebugStatus();
    });

    let eventSource: EventSource | null = null;
    let eventRefreshTimer: number | null = null;
    const scheduleEventRefresh = (eventReason = "unknown", sessionId: string | null = null) => {
      if (eventRefreshTimer !== null) {
        void postDebugLog("session_event.reconcile_skip", {
          reason: eventReason,
          sessionId,
        });
        return;
      }

      void postDebugLog("session_event.reconcile_scheduled", {
        reason: eventReason,
        sessionId,
        delayMs: 650,
      });
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = null;
        void refreshSessions("sse-reconcile");
      }, 650);
    };
    const handleSessionChanged = (event: MessageEvent) => {
      const receivedAtMs = Date.now();
      const applyStartedAt = performance.now();
      let eventReason = "unknown";
      let eventSessionId: string | null = null;
      try {
        const payload = JSON.parse(event.data) as {
          brokerPublishedAtMs?: number;
          reason?: string;
          sequence?: number;
          session?: AgentSession;
          sessionId?: string | null;
        };
        const changedSession = payload.session;
        eventReason = payload.reason ?? "unknown";
        eventSessionId = payload.sessionId ?? changedSession?.sessionId ?? null;
        void postDebugLog("session_event.received", {
          sequence: payload.sequence ?? null,
          reason: eventReason,
          sessionId: eventSessionId,
          hasSession: Boolean(changedSession),
          sessionState: changedSession?.state ?? null,
          pendingPromptId: changedSession?.pendingPromptId ?? null,
          brokerToOverlayMs:
            typeof payload.brokerPublishedAtMs === "number" ? receivedAtMs - payload.brokerPublishedAtMs : null,
        });
        if (eventReason === "dismiss-all") {
          setSessions([]);
          setSessionOrder([]);
          setCandidateMenu(null);
          setWorkspacePanel(null);
          setLastRefreshAt(new Date().toISOString());
          void postDebugLog("session_event.dismiss_all_applied", {
            sequence: payload.sequence ?? null,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
        } else if (changedSession?.sessionId && changedSession.dismissedAt) {
          setSessions((previousSessions) => {
            const nextSessions = previousSessions.filter((session) => session.sessionId !== changedSession.sessionId);
            sessionsRef.current = nextSessions;
            return nextSessions;
          });
          setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => sessionId !== changedSession.sessionId));
          setCandidateMenu((current) =>
            current?.session.sessionId === changedSession.sessionId ? null : current,
          );
          setWorkspacePanel((current) =>
            current?.session.sessionId === changedSession.sessionId ? null : current,
          );
          setLastRefreshAt(new Date().toISOString());
          void postDebugLog("session_event.dismiss_applied", {
            sequence: payload.sequence ?? null,
            reason: eventReason,
            sessionId: changedSession.sessionId,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
        } else if (changedSession?.sessionId) {
          setSessions((previousSessions) => {
            const nextSessions = mergeChangedSession(previousSessions, changedSession);
            sessionsRef.current = nextSessions;
            return nextSessions;
          });
          setSessionOrder((previousOrder) =>
            previousOrder.includes(changedSession.sessionId)
              ? previousOrder
              : [...previousOrder, changedSession.sessionId],
          );
          setLastRefreshAt(new Date().toISOString());
          void postDebugLog("session_event.optimistic_applied", {
            sequence: payload.sequence ?? null,
            reason: eventReason,
            sessionId: changedSession.sessionId,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
          if (eventReason === "obsidian-annotations") {
            window.setTimeout(() => autoCopyAndFocusPendingPrompt(changedSession, eventReason), 0);
          }
        }
      } catch (error) {
        void postDebugLog("session_event.parse_error", {
          message: (error as Error).message,
        });
        // Fall through to the full refresh below; event payloads are an optimization.
      }

      scheduleEventRefresh(eventReason, eventSessionId);
    };

    if (typeof EventSource !== "undefined") {
      try {
        eventSource = new EventSource(BROKER_SESSION_EVENTS_URL);
        eventSource.onopen = () => {
          setBrokerReadiness((current) =>
            current.state === "ready"
              ? current
              : {
                  state: "ready",
                  message: "Broker ready",
                  detail: "Event stream connected",
                },
          );
          void postDebugLog("session_event.stream_open", {
            url: BROKER_SESSION_EVENTS_URL,
          });
        };
        eventSource.onerror = () => {
          void postDebugLog("session_event.stream_error", {
            readyState: eventSource?.readyState ?? null,
          });
        };
        eventSource.addEventListener("sessions.changed", handleSessionChanged);
      } catch {
        void postDebugLog("session_event.stream_create_error", {
          url: BROKER_SESSION_EVENTS_URL,
        });
        eventSource = null;
      }
    } else {
      void postDebugLog("session_event.unsupported", {});
    }

    const interval = window.setInterval(() => {
      void refreshSessions("interval");
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (eventRefreshTimer !== null) {
        window.clearTimeout(eventRefreshTimer);
      }
      eventSource?.close();
    };
  }, []);

  return (
    <main className={`overlay-shell ${collapsed ? "is-collapsed" : ""}`}>
      <header
        className="overlay-header"
        data-tauri-drag-region
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }

          void getCurrentWindow().startDragging().catch(() => undefined);
        }}
      >
        <div className="header-title" data-tauri-drag-region>
          <GripHorizontal size={16} aria-hidden="true" />
          <div data-tauri-drag-region>
            <strong>Agents</strong>
            <span>
              {brokerReadinessLabels[brokerReadiness.state]}
              {lastRefreshAt ? ` · ${formatAgo(lastRefreshAt)} ago` : ""}
              {debugEnabled ? ` · debug ${debugCount}` : ""}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`icon-button ${activeUtilityWindow === "settings" ? "is-active" : ""}`}
            title="Open settings"
            onClick={() => {
              void openSettingsDialog("scratchpad");
            }}
          >
            <Settings2 size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-button debug-button ${debugEnabled ? "is-active" : ""}`}
            title={debugEnabled ? "Disable debug logging" : "Enable debug logging"}
            disabled={debugBusy}
            onClick={() => void toggleDebugLogging()}
          >
            <Bug size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" title="Refresh sessions" onClick={() => void refreshSessions("manual")}>
            <RefreshCcw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-button ${activeUtilityWindow === "deploy" ? "is-active" : ""}`}
            title="Open deploy window"
            onClick={() => {
              void openDeployDialog();
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" title="Collapse overlay" onClick={toggleCollapsed}>
            {collapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="Minimize"
            onClick={() => void getCurrentWindow().minimize().catch(() => undefined)}
          >
            <Minimize2 size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {collapsed ? (
        <button className="collapsed-summary" type="button" onClick={toggleCollapsed}>
          <span className={brokerReady && attentionCount > 0 ? "pulse-dot" : brokerReady && reviewCount > 0 ? "review-dot" : "quiet-dot"} />
          <span>{brokerReady ? `${sessions.length} sessions` : brokerReadinessLabels[brokerReadiness.state]}</span>
          <strong>
            {brokerReady
              ? `${attentionCount} attention${reviewCount > 0 ? ` · ${reviewCount} review` : ""}`
              : brokerReadiness.message}
          </strong>
        </button>
      ) : (
        <>
          <section className="summary-strip" aria-label="Session summary">
            <div className="summary-info">
              {brokerReady ? (
                <>
                  <span>{sessions.length} active lines</span>
                  <strong>{attentionCount} need attention</strong>
                  {reviewCount > 0 ? <strong className="summary-review">{reviewCount} review</strong> : null}
                  {sessionFilter !== "all" || sessionSearch.trim() ? <em>{filteredSessions.length} shown</em> : null}
                </>
              ) : (
                <>
                  <span>{brokerReadinessLabels[brokerReadiness.state]}</span>
                  <strong>{brokerReadiness.message}</strong>
                </>
              )}
            </div>
            {brokerReady ? (
              <div className="summary-controls" aria-label="Session filters">
                {(["all", "attention", "idle"] as SessionFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`summary-filter-button ${sessionFilter === filter ? "is-active" : ""}`}
                    title={sessionFilterLabels[filter]}
                    aria-label={`Show ${sessionFilterLabels[filter]} cards`}
                    onClick={() => setSessionFilter(filter)}
                  >
                    {filter === "all" ? <ListFilter size={12} aria-hidden="true" /> : null}
                    {filter === "attention" ? <AlertTriangle size={12} aria-hidden="true" /> : null}
                    {filter === "idle" ? <Clock size={12} aria-hidden="true" /> : null}
                  </button>
                ))}
                <label className="summary-search" title="Search cards">
                  <Search size={11} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search cards"
                    placeholder="Search"
                    value={sessionSearch}
                    onChange={(event) => setSessionSearch(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : (
              <button type="button" className="summary-retry-button" onClick={() => void ensureBrokerThenRefresh()}>
                Retry
              </button>
            )}
          </section>

          <section className="session-list" aria-label="Agent sessions">
            {!brokerReady ? (
              <BrokerReadinessPanel
                readiness={brokerReadiness}
                onRetry={() => void ensureBrokerThenRefresh()}
              />
            ) : orderedSessions.length > 0 ? orderedSessions.map((session) => (
              <div
                role="button"
                tabIndex={0}
                key={session.sessionId}
                ref={(element) => {
                  if (element) {
                    rowRefs.current.set(session.sessionId, element);
                  } else {
                    rowRefs.current.delete(session.sessionId);
                  }
                }}
                className={`session-row state-${session.state} ${session.needsAttention ? "needs-attention" : ""} ${
                  sessionNeedsReview(session) ? "needs-review" : ""
                } ${sessionHasAttentionSignal(session) ? "has-attention-signal" : ""} ${
                  isSessionVisualAttentionActive(session) ? "is-attention-animating" : ""
                } ${isSessionVisuallySeen(session) ? "is-attention-seen" : ""} ${
                  cardDrag?.sessionId === session.sessionId ? "is-drag-placeholder" : ""
                } ${dropTargetId === session.sessionId ? "is-drop-target" : ""}`}
                onClick={(event) => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    return;
                  }

                  void activateSession(session, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void activateSession(session);
                  }
                }}
              >
                <span
                  className="row-drag-handle"
                  title="Drag card"
                  onPointerDown={(event) => startCardDrag(session, event)}
                  onPointerUp={endCardDrag}
                  onPointerCancel={endCardDrag}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <GripVertical size={15} aria-hidden="true" />
                </span>
                <SessionRowContent
                  session={session}
                  activating={activatingId === session.sessionId}
                  openingTarget={openingPath?.sessionId === session.sessionId ? openingPath.target : null}
                  unbindingWindow={unbindingWindowId === session.sessionId}
                  reviewing={reviewingSessionId === session.sessionId}
                  dismissing={dismissingSessionId === session.sessionId}
                  attentionSignal={sessionHasAttentionSignal(session)}
                  attentionVisualActive={isSessionVisualAttentionActive(session)}
                  onOpenNote={() => void openBridgePath(session, "note")}
                  onOpenCanvas={() => void openBridgePath(session, "canvas")}
                  onMarkReviewed={() => void markSessionReviewed(session, "manual")}
                  onUnbindWindow={() => void clearWindowBinding(session)}
                  onDismiss={() => void dismissSession(session)}
                  onOpenCodexAppTarget={() => void openCodexAppTarget(session, true)}
                  onActivateSession={() => void activateSession(session)}
                  onOpenWorkspacePanel={(x, y) => void openWorkspacePanel(session, x, y)}
                />
              </div>
            )) : (
              <div className="session-empty-state">
                No matching cards.
              </div>
            )}
          </section>

          {candidateMenu ? (
            <section
              className="candidate-menu"
              style={{ left: candidateMenu.x, top: candidateMenu.y }}
              aria-label="Target candidates"
            >
              <div className="candidate-menu-header">
                <strong>Choose Target</strong>
                <button
                  type="button"
                  className="candidate-close"
                  title="Close"
                  onClick={() => setCandidateMenu(null)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <label className="candidate-bind-toggle">
                <input
                  type="checkbox"
                  checked={candidateMenu.bindOnSelect}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setCandidateMenu((current) =>
                      current ? { ...current, bindOnSelect: checked } : current,
                    );
                  }}
                />
                <span>Remember target</span>
              </label>
              <div className="candidate-list">
                {candidateMenu.codexCliResumeAvailable ? (
                  <button
                    type="button"
                    className="candidate-item codex-cli-candidate"
                    title={`codex resume ${candidateMenu.session.sessionId}`}
                    onClick={() =>
                      void openCodexCliTarget(candidateMenu.session, candidateMenu.bindOnSelect)
                    }
                  >
                    <strong>Codex CLI</strong>
                    <span>Resume session in project terminal</span>
                  </button>
                ) : null}
                {candidateMenu.codexAppAvailable ? (
                  <button
                    type="button"
                    className="candidate-item codex-app-candidate"
                    title={codexAppThreadUri(candidateMenu.session.sessionId)}
                    onClick={() =>
                      void openCodexAppTarget(candidateMenu.session, candidateMenu.bindOnSelect)
                    }
                  >
                    <strong>Codex App</strong>
                    <span>Open thread {candidateMenu.session.sessionId}</span>
                  </button>
                ) : null}
                {candidateMenu.candidates.map((candidate) => (
                  <button
                    type="button"
                    className="candidate-item"
                    key={`${candidate.hwnd}-${candidate.processId}`}
                    title={candidate.label}
                    onClick={() =>
                      void activateCandidate(candidateMenu.session, candidate, candidateMenu.bindOnSelect)
                    }
                  >
                    <strong>{candidate.processName ?? "Window"}</strong>
                    <span>{candidate.title}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {workspacePanel ? (
            <section
              className={`workspace-panel tone-${maintenanceToneForSession(workspacePanel.session, workspacePanel.status)}`}
              style={{ left: workspacePanel.x, top: workspacePanel.y }}
              aria-label="Workspace maintenance"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="workspace-panel-header">
                <div>
                  <strong>{projectName(workspacePathForSession(workspacePanel.session))}</strong>
                  <span>{workspacePanel.status ? (workspacePanel.status.ok ? "Ready" : "Needs review") : "Checking"}</span>
                </div>
                <button
                  type="button"
                  className="candidate-close"
                  title="Close"
                  onClick={() => setWorkspacePanel(null)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>

              <div className="workspace-task-title-editor">
                <label>
                  <span>任务名</span>
                  <input
                    type="text"
                    value={workspacePanel.taskTitleDraft}
                    placeholder={workspacePanel.session.title}
                    disabled={workspacePanel.busy !== null}
                    onChange={(event) => {
                      const nextTaskTitleDraft = event.currentTarget.value;
                      setWorkspacePanel((current) =>
                        current ? { ...current, taskTitleDraft: nextTaskTitleDraft } : current,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveWorkspacePanelTaskTitle();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={workspacePanel.busy !== null}
                  onClick={() => void saveWorkspacePanelTaskTitle()}
                >
                  Save
                </button>
                <button
                  type="button"
                  disabled={workspacePanel.busy !== null || !workspacePanel.session.taskTitle}
                  onClick={() => void saveWorkspacePanelTaskTitle("")}
                >
                  Clear
                </button>
              </div>

              <div className="workspace-panel-actions">
                <button
                  type="button"
                  disabled={workspacePanel.busy !== null}
                  onClick={() => void loadWorkspaceStatus(workspacePanel.session)}
                >
                  <RefreshCcw size={12} aria-hidden="true" />
                  <span>{workspacePanel.busy === "status" ? "Checking" : "Check"}</span>
                </button>
                <button
                  type="button"
                  disabled={workspacePanel.busy !== null}
                  onClick={() =>
                    void openMaintenancePath(
                      workspacePanel.status?.paths.workspace ?? workspacePathForSession(workspacePanel.session),
                      "workspace",
                    )
                  }
                >
                  <FolderOpen size={12} aria-hidden="true" />
                  <span>Project</span>
                </button>
                <button
                  type="button"
                  disabled={workspacePanel.busy !== null}
                  onClick={() =>
                    void openMaintenancePath(
                      workspacePanel.status?.paths.vaultRoot ?? workspacePanel.session.vaultRoot,
                      "vault",
                    )
                  }
                >
                  <FolderOpen size={12} aria-hidden="true" />
                  <span>Vault</span>
                </button>
                <button
                  type="button"
                  className="danger-action"
                  disabled={workspacePanel.busy !== null}
                  onClick={() => requestCleanWorkspaceVault()}
                >
                  <Trash2 size={12} aria-hidden="true" />
                  <span>{workspacePanel.busy === "clean" ? "Cleaning" : "Clean"}</span>
                </button>
              </div>

              {workspacePanel.error ? <p className="workspace-panel-error">{workspacePanel.error}</p> : null}

              {workspacePanel.status ? (
                <div className="workspace-panel-content">
                  <div className="workspace-stats">
                    <span>
                      <strong>{workspacePanel.status.counts.sessionFolders ?? 0}</strong>
                      Sessions
                    </span>
                    <span>
                      <strong>{workspacePanel.status.counts.replyNotes}</strong>
                      Replies
                    </span>
                    <span>
                      <strong>{workspacePanel.status.counts.promptNotes}</strong>
                      Prompts
                    </span>
                    <span>
                      <strong>{workspacePanel.status.counts.canvasNodes}</strong>
                      Nodes
                    </span>
                  </div>

                  <div className="workspace-section">
                    <strong>Folders</strong>
                    <div className="workspace-path-grid">
                      <span className={workspacePanel.status.exists.amoRoot ? "is-ok" : "is-bad"}>.amo</span>
                      <code title={workspacePanel.status.paths.amoRoot}>{shortPathLabel(workspacePanel.status.paths.amoRoot)}</code>
                      <span className={workspacePanel.status.exists.vaultRoot ? "is-ok" : "is-bad"}>vault</span>
                      <code title={workspacePanel.status.paths.vaultRoot}>{shortPathLabel(workspacePanel.status.paths.vaultRoot)}</code>
                      <span className={workspacePanel.status.exists.sessions ? "is-ok" : "is-bad"}>Sessions</span>
                      <code title={workspacePanel.status.paths.sessions}>{shortPathLabel(workspacePanel.status.paths.sessions)}</code>
                      <span className={workspacePanel.status.exists.generated ? "is-ok" : "is-bad"}>Generated</span>
                      <code title={workspacePanel.status.paths.generated}>{shortPathLabel(workspacePanel.status.paths.generated)}</code>
                      <span className={workspacePanel.status.exists.workCanvases ? "is-ok" : "is-bad"}>Work</span>
                      <code title={workspacePanel.status.paths.workCanvases}>
                        {shortPathLabel(workspacePanel.status.paths.workCanvases)}
                      </code>
                    </div>
                  </div>

                  <div className="workspace-section">
                    <strong>Canvas</strong>
                    <span className={`workspace-health-line ${workspacePanel.status.canvas.amoManaged ? "is-ok" : "is-bad"}`}>
                      {workspacePanel.status.canvas.amoManaged ? <CircleCheck size={12} /> : <AlertTriangle size={12} />}
                      {workspacePanel.status.canvas.amoManaged ? "AMO managed" : "AMO marker missing"}
                    </span>
                    {workspacePanel.status.canvas.marker ? (
                      <code className="workspace-code-line">
                        {workspacePanel.status.canvas.marker.managedBy} / {workspacePanel.status.canvas.marker.canvasType}
                      </code>
                    ) : null}
                  </div>

                  <div className="workspace-section">
                    <strong>Plugin</strong>
                    <span
                      className={`workspace-health-line ${
                        workspacePanel.status.pluginHealth?.ok ? "is-ok" : "is-warning"
                      }`}
                      title={workspacePanel.status.pluginHealth ? pluginHealthTitle(workspacePanel.status.pluginHealth) : undefined}
                    >
                      {workspacePanel.status.pluginHealth?.ok ? <CircleCheck size={12} /> : <AlertTriangle size={12} />}
                      {workspacePanel.status.pluginHealth?.installedVersion ?? "missing"} / expected{" "}
                      {workspacePanel.status.pluginHealth?.expectedVersion ?? "unknown"}
                    </span>
                  </div>

                  {workspacePanel.status.issues.length > 0 ? (
                    <div className="workspace-section">
                      <strong>Issues</strong>
                      <div className="workspace-issues">
                        {workspacePanel.status.issues.slice(0, 5).map((issue) => (
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
          ) : null}

          {settingsOpen ? (
            <div
              className="dialog-backdrop settings-backdrop"
              role="presentation"
              onClick={() => void closeSettingsDialog()}
            >
              <section
                className="app-dialog settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="AMO settings"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="app-dialog-titlebar" data-tauri-drag-region onPointerDown={startDialogDrag}>
                  <div className="app-dialog-title" data-tauri-drag-region>
                    <Settings2 size={16} aria-hidden="true" />
                    <div data-tauri-drag-region>
                      <strong>Settings</strong>
                      <span>AMO workspace and utility preferences</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="candidate-close"
                    title="Close settings"
                    onClick={() => void closeSettingsDialog()}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </header>

                <SettingsSidebar settingsSection={settingsSection} onSettingsSectionChange={setSettingsSection} />

                <SettingsDetail
                  settingsSection={settingsSection}
                  scratchpadShortcut={scratchpadShortcut}
                  amoTheme={amoTheme}
                  onScratchpadShortcutChange={(next) => void updateScratchpadShortcut(next)}
                  onOpenScratchpadNow={() => void openScratchpadNow()}
                  onAmoThemeChange={(next) => void updateAmoTheme(next)}
                />
              </section>
            </div>
          ) : null}

          {obsidianVaultRecovery ? (
            <div
              className="confirm-backdrop"
              role="presentation"
              onClick={() => setObsidianVaultRecovery(null)}
            >
              <section
                className="vault-recovery-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Open AMO vault in Obsidian"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="confirm-dialog-header">
                  <strong>Obsidian Vault Not Loaded</strong>
                  <button
                    type="button"
                    className="candidate-close"
                    title="Close"
                    onClick={() => setObsidianVaultRecovery(null)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
                <p>
                  Obsidian is running, but this AMO vault has not been loaded by the current Obsidian session.
                  Open this folder as a vault in Obsidian once, then click the{" "}
                  {obsidianVaultRecovery.target === "note" ? "Note" : "Canvas"} button again.
                </p>
                <div className="vault-recovery-path" title={obsidianVaultRecovery.vaultRoot}>
                  {obsidianVaultRecovery.vaultRoot}
                </div>
                <div className="vault-recovery-manual">
                  In Obsidian, use <span>Open folder as vault</span> and choose this path. AMO will use the plugin
                  bridge after the vault is loaded.
                </div>
                <div className="vault-recovery-actions">
                  <button
                    type="button"
                    onClick={() => void openRecoveryVaultFolder()}
                    disabled={obsidianVaultRecovery.busy !== null}
                  >
                    <FolderOpen size={13} aria-hidden="true" />
                    <span>{obsidianVaultRecovery.busy === "explorer" ? "Opening" : "Open Folder"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyRecoveryVaultPath()}
                    disabled={obsidianVaultRecovery.busy !== null}
                  >
                    <ClipboardCheck size={13} aria-hidden="true" />
                    <span>{obsidianVaultRecovery.busy === "copy" ? "Copying" : "Copy Path"}</span>
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {cleanConfirm ? (
            <div
              className="confirm-backdrop"
              role="presentation"
              onClick={() => setCleanConfirm(null)}
            >
              <section
                className="confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm AMO vault cleanup"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="confirm-dialog-header">
                  <strong>Clean AMO Vault?</strong>
                  <button
                    type="button"
                    className="candidate-close"
                    title="Cancel"
                    onClick={() => setCleanConfirm(null)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
                <p>
                  This will clear generated notes and reset the canvas for{" "}
                  <strong>{projectName(cleanConfirm.workspacePath)}</strong>.
                </p>
                <div className="confirm-counts">
                  <span>
                    <strong>{cleanConfirm.replyNotes}</strong>
                    replies
                  </span>
                  <span>
                    <strong>{cleanConfirm.promptNotes}</strong>
                    prompts
                  </span>
                  <span>
                    <strong>{cleanConfirm.canvasNodes}</strong>
                    nodes
                  </span>
                </div>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setCleanConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    onClick={() => void cleanWorkspaceVaultFromPanel()}
                  >
                    Confirm Clean
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {cardDrag ? (
            <div
              className="session-row drag-preview"
              style={{
                left: cardDrag.left,
                top: cardDrag.pointerY - cardDrag.offsetY,
                width: cardDrag.width,
                minHeight: cardDrag.height,
              }}
            >
              <span className="row-drag-handle is-preview" aria-hidden="true">
                <GripVertical size={15} />
              </span>
              {(() => {
                const session = sessions.find((item) => item.sessionId === cardDrag.sessionId);
                return session ? (
                  <SessionRowContent
                    session={session}
                    activating={activatingId === session.sessionId}
                    openingTarget={openingPath?.sessionId === session.sessionId ? openingPath.target : null}
                    unbindingWindow={unbindingWindowId === session.sessionId}
                    reviewing={reviewingSessionId === session.sessionId}
                    dismissing={dismissingSessionId === session.sessionId}
                    attentionSignal={sessionHasAttentionSignal(session)}
                    attentionVisualActive={isSessionVisualAttentionActive(session)}
                    onOpenNote={() => undefined}
                    onOpenCanvas={() => undefined}
                    onMarkReviewed={() => undefined}
                    onUnbindWindow={() => undefined}
                    onDismiss={() => undefined}
                    onOpenCodexAppTarget={() => undefined}
                    onActivateSession={() => undefined}
                    onOpenWorkspacePanel={() => undefined}
                  />
                ) : null;
              })()}
            </div>
          ) : null}

          <footer className="feedback-line" title={feedback}>
            {feedback}
          </footer>

          <div
            className={`resize-edge ${isResizing ? "is-resizing" : ""}`}
            title="Resize height"
            onPointerDown={(event) => void startWindowResize(event, "vertical")}
            onPointerMove={continueWindowResize}
            onPointerUp={endWindowResize}
            onPointerCancel={endWindowResize}
          />
          <div
            className={`resize-side ${isResizing ? "is-resizing" : ""}`}
            title="Resize width"
            onPointerDown={(event) => void startWindowResize(event, "horizontal")}
            onPointerMove={continueWindowResize}
            onPointerUp={endWindowResize}
            onPointerCancel={endWindowResize}
          />
          <div
            className={`resize-corner ${isResizing ? "is-resizing" : ""}`}
            title="Resize"
            onPointerDown={(event) => void startWindowResize(event, "both")}
            onPointerMove={continueWindowResize}
            onPointerUp={endWindowResize}
            onPointerCancel={endWindowResize}
          />

          {activeUtilityWindow ? (
            <div
              className="main-window-blocker"
              role="presentation"
              title={`Focus ${activeUtilityWindow === "deploy" ? "Deploy Workspace" : "Settings"}`}
              onClick={() => void focusUtilityWindow(activeUtilityWindow)}
            >
              <div
                className="main-window-blocker-card"
                role="dialog"
                aria-label="Utility window active"
                onClick={(event) => event.stopPropagation()}
              >
                <span>{activeUtilityWindow === "deploy" ? "Deploy Workspace" : "Settings"} is open</span>
                <div className="main-window-blocker-actions">
                  <button type="button" onClick={() => void focusUtilityWindow(activeUtilityWindow)}>
                    Focus
                  </button>
                  <button type="button" onClick={() => void hideUtilityWindow(activeUtilityWindow)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {deployOpen ? (
        <div className="dialog-backdrop deploy-backdrop" role="presentation" onClick={() => void closeDeployDialog()}>
          <section
            className="app-dialog deploy-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace deployment"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="app-dialog-titlebar" data-tauri-drag-region onPointerDown={startDialogDrag}>
              <div className="app-dialog-title" data-tauri-drag-region>
                <FolderPlus size={16} aria-hidden="true" />
                <div data-tauri-drag-region>
                  <strong>Deploy Workspace</strong>
                  <span>Project-local hooks and AMO vault</span>
                </div>
              </div>
              <button
                type="button"
                className="candidate-close"
                title="Close deploy"
                onClick={() => void closeDeployDialog()}
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
                    {deployBusy === "enroll" ? "Deploying" : "Deploy"}
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    title="Clear generated session notes and reset the base canvas without removing hooks."
                    disabled={!workspaceInspection?.existingEnrollment || deployBusy !== null || launchBusy !== null}
                    onClick={() => void clearWorkspaceGeneratedFromDeploy()}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    <span>{deployBusy === "clean" ? "Clearing" : "Clear Generated"}</span>
                  </button>
                </div>

                {workspaceInspection ? (
                  <dl className="deploy-status-grid">
                    <div>
                      <dt>Path</dt>
                      <dd title={workspaceInspection.workspacePath}>{shortPathLabel(workspaceInspection.workspacePath)}</dd>
                    </div>
                    <div>
                      <dt>State</dt>
                      <dd>{workspaceInspection.existingEnrollment ? "enrolled" : "not enrolled"}</dd>
                    </div>
                    <div>
                      <dt>Selected</dt>
                      <dd>{selectedDeployAdapters.length}</dd>
                    </div>
                  </dl>
                ) : (
                  <div className="deploy-placeholder">Check a workspace to review deployment status.</div>
                )}
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
                      const stateLabel = adapterStateLabel(adapter);
                      const contextLabel = adapterContextLabel(adapter);
                      return (
                        <label
                          className={`deploy-adapter-card status-${adapter.status} state-${stateLabel} ${
                            selected ? "is-selected" : ""
                          }`}
                          key={adapter.id}
                          title={adapter.reason}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={!selectable || deployBusy !== null}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setSelectedDeployAdapters((current) =>
                                checked
                                  ? Array.from(new Set([...current, adapter.id]))
                                  : current.filter((id) => id !== adapter.id),
                              );
                            }}
                          />
                          <span className="deploy-adapter-copy">
                            <strong>{adapter.label}</strong>
                            <span>{adapter.reason}</span>
                          </span>
                          <span className="deploy-adapter-badges">
                            <em>{stateLabel}</em>
                            {contextLabel ? <small>{contextLabel}</small> : null}
                          </span>
                        </label>
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
                  <div className="deploy-result-summary">
                    <strong>{workspaceEnrollment.installedAdapters.join(", ")}</strong>
                    <span>{workspaceEnrollment.installedFiles.length} files</span>
                    <span>{workspaceEnrollment.mergedFiles.length} merged</span>
                  </div>
                  <div className="deploy-launch-actions" aria-label="Launch workspace tools">
                    {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
                      <button
                        type="button"
                        disabled={deployBusy !== null || launchBusy !== null}
                        onClick={() => void launchWorkspace("codex-cli")}
                      >
                        <SquareTerminal size={12} aria-hidden="true" />
                        <span>{launchBusy === "codex-cli" ? "Starting" : "Run Codex"}</span>
                      </button>
                    ) : null}
                    {workspaceEnrollment.installedAdapters.includes("claude-cli") ? (
                      <button
                        type="button"
                        disabled={deployBusy !== null || launchBusy !== null}
                        onClick={() => void launchWorkspace("claude-cli")}
                      >
                        <SquareTerminal size={12} aria-hidden="true" />
                        <span>{launchBusy === "claude-cli" ? "Starting" : "Run Claude"}</span>
                      </button>
                    ) : null}
                    {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
                      <button
                        type="button"
                        disabled={deployBusy !== null || launchBusy !== null}
                        onClick={() => void launchWorkspace("codex-app")}
                      >
                        <Bot size={12} aria-hidden="true" />
                        <span>{launchBusy === "codex-app" ? "Opening" : "Open App"}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={deployBusy !== null || launchBusy !== null}
                      onClick={() => void openMaintenancePath(workspaceEnrollment.workspacePath, "workspace")}
                    >
                      <FolderOpen size={12} aria-hidden="true" />
                      <span>Project</span>
                    </button>
                    <button
                      type="button"
                      disabled={deployBusy !== null || launchBusy !== null}
                      onClick={() => void openMaintenancePath(workspaceEnrollment.vaultRoot, "vault")}
                    >
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
        </div>
      ) : null}
    </main>
  );
}
