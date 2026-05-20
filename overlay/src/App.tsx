import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  AlertTriangle,
  Bot,
  Bug,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FileText,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  Map as MapIcon,
  Minimize2,
  RefreshCcw,
  CircleCheck,
  Unlink2,
  X,
} from "lucide-react";
import claudeCliIcon from "./assets/tool-icons/claude-cli.png";
import codexAppIcon from "./assets/tool-icons/codex-app.png";
import codexCliIcon from "./assets/tool-icons/codex-cli.png";
import kiroIdeIcon from "./assets/tool-icons/kiro-ide.png";
import { mockSessions } from "./mockSessions";
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
  WorkspaceEnrollment,
  WorkspaceInspection,
} from "./types";

const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
const BROKER_OBSIDIAN_REGISTER_VAULT_URL = "http://127.0.0.1:17654/api/obsidian/register-vault";
const BROKER_SYNC_BACK_URL = "http://127.0.0.1:17654/api/sync-back";
const BROKER_WORKSPACE_INSPECT_URL = "http://127.0.0.1:17654/api/workspaces/inspect";
const BROKER_WORKSPACE_ENROLL_URL = "http://127.0.0.1:17654/api/workspaces/enroll";
const BROKER_DEBUG_URL = "http://127.0.0.1:17654/api/debug";
const BROKER_DEBUG_LOGS_URL = "http://127.0.0.1:17654/api/debug/logs";
const REFRESH_INTERVAL_MS = 3000;

function brokerSessionWindowBindingUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/window-binding`;
}

function brokerSessionWindowBindingClearUrl(sessionId: string) {
  return `http://127.0.0.1:17654/api/sessions/${encodeURIComponent(sessionId)}/window-binding/clear`;
}

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

function projectName(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
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

function obsidianOpenUri(targetPath: string, vaultId?: string, vaultRoot?: string) {
  const params = new URLSearchParams();
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);

  if (vaultId && filePath) {
    params.set("vault", vaultId);
    params.set("file", filePath);
  } else {
    params.set("path", targetPath);
  }

  params.set("paneType", "tab");
  return `obsidian://open?${params.toString()}`;
}

function obsidianAmoOpenUri(
  targetPath: string,
  target: "note" | "canvas",
  vaultId?: string,
  vaultRoot?: string,
) {
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);
  if (!filePath) {
    return obsidianOpenUri(targetPath, vaultId, vaultRoot);
  }

  const params = new URLSearchParams();
  params.set("path", targetPath);
  params.set("relativePath", filePath);
  params.set("kind", target);
  return `obsidian://amo-open?${params.toString()}`;
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

function menuPosition(x?: number, y?: number) {
  const fallbackX = Math.max(12, window.innerWidth - 326);
  const fallbackY = 96;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - 326)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 220)),
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
  copyingPrompt,
  unbindingWindow,
  onOpenNote,
  onOpenCanvas,
  onCopyPrompt,
  onUnbindWindow,
}: {
  session: AgentSession;
  activating: boolean;
  openingTarget: "note" | "canvas" | null;
  copyingPrompt: boolean;
  unbindingWindow: boolean;
  onOpenNote: () => void;
  onOpenCanvas: () => void;
  onCopyPrompt: () => void;
  onUnbindWindow: () => void;
}) {
  const notePath = notePathForOpen(session);
  const canvasPath = canvasPathForOpen(session);
  const pendingPromptLabel = session.pendingAnnotationCount ? `Sync ${session.pendingAnnotationCount}` : "Sync";
  const windowBound = Boolean(session.windowHint?.hwnd || session.windowHint?.pid);
  const noteOpening = openingTarget === "note";
  const canvasOpening = openingTarget === "canvas";
  const pluginHealth = session.obsidianPluginHealth;
  const PluginHealthIcon = pluginHealth?.ok ? CircleCheck : AlertTriangle;
  const waitingForPermission = session.state === "waiting_permission";
  const display = toolDisplayForSession(session);
  const statusLabel = activating ? "Opening" : stateLabel[session.state];

  return (
    <span className="session-main">
      <span className="session-head">
        <ToolMark session={session} />
        <span className="session-title">
          <strong>{projectName(session.cwd)}</strong>
          <span>
            {display.label} · {formatAgo(session.updatedAt)}
          </span>
        </span>
        <span className="state-pill">
          <span className="state-dot" aria-hidden="true" />
          <span>{statusLabel}</span>
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
            {windowBound ? (
              <span className="session-tag" title={session.windowHint?.boundLabel ?? session.windowHint?.title ?? session.title}>
                Window bound
              </span>
            ) : null}
            {pluginHealth ? (
              <span className={`session-tag plugin-tag health-${pluginHealth.status}`} title={pluginHealthTitle(pluginHealth)}>
                <PluginHealthIcon size={11} aria-hidden="true" />
                Plugin
              </span>
            ) : null}
          </span>
        </span>
        {notePath || canvasPath || session.pendingPrompt || windowBound || pluginHealth || waitingForPermission ? (
          <span className="bridge-actions" aria-label="Bridge actions">
            {waitingForPermission ? (
              <span className="permission-pill" title="点击卡片切回 CLI，手动处理权限请求">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>需要权限</span>
              </span>
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
            {session.pendingPrompt ? (
              <button
                type="button"
                className={`row-tool-button sync-button ${session.pendingPromptCopiedAt ? "was-copied" : ""} ${
                  copyingPrompt ? "is-busy" : ""
                }`}
                aria-busy={copyingPrompt}
                title="Copy pending prompt and focus CLI"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onCopyPrompt();
                }}
              >
                <ClipboardCheck size={13} aria-hidden="true" />
                <span>{pendingPromptLabel}</span>
              </button>
            ) : null}
            {windowBound ? (
              <button
                type="button"
                className={`row-tool-button binding-button ${unbindingWindow ? "is-busy" : ""}`}
                aria-busy={unbindingWindow}
                title={`Unbind window: ${session.windowHint?.boundLabel ?? session.windowHint?.title ?? session.title}`}
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

export default function App() {
  const [sessions, setSessions] = useState<AgentSession[]>(mockSessions);
  const [sessionOrder, setSessionOrder] = useState<string[]>(() =>
    mockSessions.map((session) => session.sessionId),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [source, setSource] = useState<"mock" | "broker">("mock");
  const [feedback, setFeedback] = useState("Mock data ready. Window activation is placeholder.");
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<{ sessionId: string; target: "note" | "canvas" } | null>(null);
  const [copyingPromptId, setCopyingPromptId] = useState<string | null>(null);
  const [unbindingWindowId, setUnbindingWindowId] = useState<string | null>(null);
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceInspection, setWorkspaceInspection] = useState<WorkspaceInspection | null>(null);
  const [workspaceEnrollment, setWorkspaceEnrollment] = useState<WorkspaceEnrollment | null>(null);
  const [deployBusy, setDeployBusy] = useState<"inspect" | "enroll" | null>(null);
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugCount, setDebugCount] = useState(0);
  const [debugBusy, setDebugBusy] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sessionsRef = useRef(sessions);
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const cardDragRef = useRef<CardDragState | null>(null);
  const cardDragCleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const suppressNextClickRef = useRef(false);

  const orderedSessions = useMemo(
    () => applySessionOrder(sessions, sessionOrder).slice(0, 8),
    [sessions, sessionOrder],
  );

  const attentionCount = useMemo(
    () => sessions.filter((session) => session.needsAttention).length,
    [sessions],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    orderedSessionsRef.current = orderedSessions;
  }, [orderedSessions]);

  useEffect(() => {
    return () => removeCardDragListeners();
  }, []);

  async function refreshSessions() {
    try {
      const response = await fetch(BROKER_SESSIONS_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }

      const payload = await response.json();
      const nextSessions = normalizeSessions(payload);
      if (!nextSessions || nextSessions.length === 0) {
        throw new Error("broker response has no sessions");
      }

      const visibleSessions = nextSessions.slice(0, 8);
      setSessions(visibleSessions);
      setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, visibleSessions));
      setSource("broker");
      setLastRefreshAt(new Date().toISOString());
      setFeedback(`Broker sessions loaded: ${nextSessions.length}`);
    } catch (error) {
      setSessions(mockSessions);
      setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, mockSessions));
      setSource("mock");
      setLastRefreshAt(new Date().toISOString());
      setFeedback(`Using mock sessions: ${(error as Error).message}`);
    }
  }

  async function ensureBrokerThenRefresh() {
    try {
      const result = await invoke<BrokerEnsureResult>("ensure_broker");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Broker auto-start unavailable: ${(error as Error).message}`);
    }

    await refreshSessions();
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

  async function refreshDebugStatus() {
    try {
      const response = await fetch(BROKER_DEBUG_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }

      const result = (await response.json()) as BrokerDebugStatus;
      setDebugEnabled(Boolean(result.enabled));
      setDebugCount(result.count ?? 0);
    } catch {
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
      setDebugEnabled(Boolean(result.enabled));
      setDebugCount(result.count ?? 0);
      setFeedback(result.enabled ? "Debug logging enabled." : "Debug logging disabled.");
    } catch (error) {
      setFeedback(`Debug toggle failed: ${(error as Error).message}`);
    } finally {
      setDebugBusy(false);
    }
  }

  async function postDebugLog(event: string, data?: unknown) {
    if (!debugEnabled) return;

    try {
      const result = await postBrokerJson<{ ok: boolean; count: number }>(BROKER_DEBUG_LOGS_URL, {
        source: "overlay",
        event,
        data: data ?? {},
      });
      setDebugCount(result.count ?? debugCount);
    } catch {
      // Debug logging must never block the overlay action being debugged.
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
      });
      void postDebugLog("workspace.inspect.ok", {
        workspacePath: result.workspacePath,
        projectName: result.projectName,
        adapters: result.supportedAdapters.map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
          confidence: adapter.confidence,
        })),
      });
      setWorkspaceInspection(result);
      setWorkspacePath(result.workspacePath);
      const codexPlan = result.supportedAdapters.find((adapter) => adapter.id === "codex-cli");
      setFeedback(`${result.projectName}: ${codexPlan?.status ?? "no adapter"} for codex-cli.`);
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

      setDeployOpen(true);
      setWorkspacePath(result.path);
      setWorkspaceInspection(null);
      setWorkspaceEnrollment(null);
      await inspectWorkspace(result.path);
    } catch (error) {
      setFeedback(`Folder selection failed: ${(error as Error).message}`);
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
      const result = await postBrokerJson<WorkspaceEnrollment>(BROKER_WORKSPACE_ENROLL_URL, {
        workspacePath: targetPath,
        adapters: ["codex-cli"],
      });
      void postDebugLog("workspace.enroll.ok", {
        workspacePath: result.workspacePath,
        vaultRoot: result.vaultRoot,
        installedAdapters: result.installedAdapters,
      });
      setWorkspaceEnrollment(result);
      setFeedback(`Deployed ${result.installedAdapters.join(", ")} for ${projectName(result.workspacePath)}.`);
      void refreshSessions();
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

  async function toggleCollapsed() {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);

    try {
      await getCurrentWindow().setSize(
        nextCollapsed ? new LogicalSize(264, 86) : new LogicalSize(380, 520),
      );
    } catch {
      // Browser preview cannot resize a native window.
    }
  }

  async function activateSession(session: AgentSession, menuX?: number, menuY?: number) {
    setActivatingId(session.sessionId);
    setCandidateMenu(null);
    setFeedback(`Activating ${session.title}...`);
    void postDebugLog("window.activate.start", {
      sessionId: session.sessionId,
      title: session.title,
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
      cwd: session.cwd,
    });

    try {
      const result = await invoke<ActivationResult>("activate_session_window", {
        sessionId: session.sessionId,
        title: session.windowHint?.title ?? session.title,
        processName: session.windowHint?.process ?? "",
        titleToken: session.windowHint?.titleToken ?? "",
        titleContains: session.windowHint?.titleContains ?? [],
        project: session.windowHint?.project ?? projectName(session.cwd),
        cwd: session.windowHint?.cwd ?? session.cwd,
        pid: session.windowHint?.pid ?? null,
        hwnd: session.windowHint?.hwnd ?? null,
      });
      if (!result.ok && result.candidates && result.candidates.length > 1) {
        const position = menuPosition(menuX, menuY);
        setCandidateMenu({
          session,
          candidates: result.candidates,
          x: position.x,
          y: position.y,
          bindOnSelect: true,
        });
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

  async function openBridgePath(session: AgentSession, target: "note" | "canvas") {
    const targetPath = target === "note" ? notePathForOpen(session) : canvasPathForOpen(session);
    if (!targetPath) {
      setFeedback(`No ${target} path is linked for ${session.title}.`);
      return;
    }

    setOpeningPath({ sessionId: session.sessionId, target });
    setFeedback(`Opening ${target} for ${session.title}...`);
    void postDebugLog("obsidian.open.start", {
      sessionId: session.sessionId,
      target,
      targetPath,
      vaultRoot: session.vaultRoot ?? null,
      vaultId: null,
    });

    try {
      let vaultId: string | undefined;
      if (session.vaultRoot) {
        const registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
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
        });
      }

      const result = await invoke<OpenPathResult>("open_uri", {
        uri: obsidianAmoOpenUri(targetPath, target, vaultId, session.vaultRoot),
      });
      void postDebugLog("obsidian.open.result", {
        sessionId: session.sessionId,
        target,
        ok: result.ok,
        message: result.message,
      });
      if (result.ok) {
        setFeedback(`${target === "note" ? "Note" : "Canvas"} opened in Obsidian.`);
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
    void postDebugLog("sync.copy.start", {
      sessionId: session.sessionId,
      pendingPromptId: session.pendingPromptId ?? null,
      promptLength: session.pendingPrompt.length,
      hasWindowBinding: Boolean(session.windowHint?.hwnd || session.windowHint?.pid),
    });

    try {
      const result = await invoke<OpenPathResult>("write_clipboard_text", { text: session.pendingPrompt });
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
      setFeedback("Pending prompt copied. Focusing target CLI...");
      void refreshSessions();
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

  async function activateCandidate(session: AgentSession, candidate: ActivationCandidate, bindWindow: boolean) {
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
            brokerSessionWindowBindingUrl(session.sessionId),
            {
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
    setFeedback(`Clearing window binding for ${session.title}...`);
    void postDebugLog("window.unbind.start", {
      sessionId: session.sessionId,
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionWindowBindingClearUrl(session.sessionId),
        {},
      );
      setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      void postDebugLog("window.unbind.ok", {
        sessionId: session.sessionId,
      });
      setFeedback("Window binding cleared.");
      void refreshSessions();
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
    const interval = window.setInterval(() => {
      void refreshSessions();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
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
              {source === "broker" ? "broker live" : "mock mode"}
              {lastRefreshAt ? ` · ${formatAgo(lastRefreshAt)} ago` : ""}
              {debugEnabled ? ` · debug ${debugCount}` : ""}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`icon-button debug-button ${debugEnabled ? "is-active" : ""}`}
            title={debugEnabled ? "Disable debug logging" : "Enable debug logging"}
            disabled={debugBusy}
            onClick={() => void toggleDebugLogging()}
          >
            <Bug size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" title="Refresh sessions" onClick={refreshSessions}>
            <RefreshCcw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-button ${deployOpen ? "is-active" : ""}`}
            title={deployOpen ? "Close deploy panel" : "Open deploy panel"}
            onClick={() => setDeployOpen((value) => !value)}
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
          <span className={attentionCount > 0 ? "pulse-dot" : "quiet-dot"} />
          <span>{sessions.length} sessions</span>
          <strong>{attentionCount} need attention</strong>
        </button>
      ) : (
        <>
          <section className="summary-strip" aria-label="Session summary">
            <span>{sessions.length} active lines</span>
            <strong>{attentionCount} need attention</strong>
          </section>

          {deployOpen ? (
            <section className="deploy-panel" aria-label="Workspace deployment">
              <div className="deploy-path-row">
                <span className="deploy-path" title={workspacePath || "No workspace selected"}>
                  {workspacePath ? shortPathLabel(workspacePath) || workspacePath : "No workspace selected"}
                </span>
                <button type="button" disabled={deployBusy !== null} onClick={() => void chooseWorkspaceDirectory()}>
                  Choose
                </button>
                <button
                  type="button"
                  title="Check folder before deploying; this does not write files."
                  disabled={!workspacePath || deployBusy !== null}
                  onClick={() => void inspectWorkspace()}
                >
                  {deployBusy === "inspect" ? "..." : "Check"}
                </button>
                <button
                  type="button"
                  disabled={!workspaceInspection || deployBusy !== null}
                  onClick={() => void enrollWorkspace()}
                >
                  {deployBusy === "enroll" ? "..." : "Deploy"}
                </button>
                <button
                  type="button"
                  className="deploy-close"
                  title="Close deploy panel"
                  onClick={() => setDeployOpen(false)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              {workspaceInspection ? (
                <div className="deploy-plan">
                  {workspaceInspection.supportedAdapters.map((adapter) => (
                    <span className={`deploy-pill status-${adapter.status}`} key={adapter.id} title={adapter.reason}>
                      <strong>{adapter.label}</strong>
                      <em>{adapter.status}</em>
                      {adapter.confidence ? <small>{adapter.confidence}</small> : null}
                    </span>
                  ))}
                  <span title={workspaceInspection.workspacePath}>{shortPathLabel(workspaceInspection.workspacePath)}</span>
                  {workspaceInspection.existingEnrollment ? <strong>enrolled</strong> : null}
                </div>
              ) : null}
              {workspaceEnrollment ? (
                <div className="deploy-result" title={workspaceEnrollment.vaultRoot}>
                  <strong>{workspaceEnrollment.installedAdapters.join(", ")}</strong>
                  <span>{workspaceEnrollment.installedFiles.length} files</span>
                  <span>{workspaceEnrollment.mergedFiles.length} merged</span>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="session-list" aria-label="Agent sessions">
            {orderedSessions.map((session) => (
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
                  copyingPrompt={copyingPromptId === session.sessionId}
                  unbindingWindow={unbindingWindowId === session.sessionId}
                  onOpenNote={() => void openBridgePath(session, "note")}
                  onOpenCanvas={() => void openBridgePath(session, "canvas")}
                  onCopyPrompt={() => void copyPendingPrompt(session)}
                  onUnbindWindow={() => void clearWindowBinding(session)}
                />
              </div>
            ))}
          </section>

          {candidateMenu ? (
            <section
              className="candidate-menu"
              style={{ left: candidateMenu.x, top: candidateMenu.y }}
              aria-label="Window candidates"
            >
              <div className="candidate-menu-header">
                <strong>Choose Window</strong>
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
                <span>Bind this window</span>
              </label>
              <div className="candidate-list">
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
                    copyingPrompt={copyingPromptId === session.sessionId}
                    unbindingWindow={unbindingWindowId === session.sessionId}
                    onOpenNote={() => undefined}
                    onOpenCanvas={() => undefined}
                    onCopyPrompt={() => undefined}
                    onUnbindWindow={() => undefined}
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
        </>
      )}
    </main>
  );
}
