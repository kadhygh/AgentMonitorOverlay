import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, UserAttentionType } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  Archive,
  Bug,
  ChevronDown,
  ChevronUp,
  Clock,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  ListFilter,
  Minimize2,
  RefreshCcw,
  Search,
  Settings2,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_DEBUG_URL,
  BROKER_OBSIDIAN_REGISTER_VAULT_URL,
  BROKER_SYNC_BACK_URL,
  BROKER_WORKSPACE_CLEAN_VAULT_URL,
  BROKER_WORKSPACE_GIT_EXCLUDE_URL,
  BROKER_WORKSPACE_INSPECT_URL,
  BROKER_WORKSPACE_LAUNCH_URL,
  BROKER_WORKSPACE_STATUS_URL,
  BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL,
  brokerSessionHeartbeatUrl,
  brokerSessionTaskTitleUrl,
  postBrokerJson,
} from "../api/brokerClient";
import {
  applySessionOrder,
  mergeChangedSession,
  mergeSessionOrder,
  sessionArchived,
  sessionAttentionKey,
  sessionAttentionVisualActive,
  sessionFilterLabels,
  formatAgo,
  sessionHasAttentionSignal,
  sessionMatchesFilter,
  sessionNeedsReview,
  type SessionFilter,
} from "../domain/sessionModel";
import {
  activationWindowRequest,
  canvasPathForOpen,
  latestCanvasNotePathForFocus,
  notePathForOpen,
  obsidianAmoOpenUri,
  obsidianOpenUri,
  projectName,
  shortPathLabel,
  targetBindingForSession,
  windowTargetForSession,
  workspacePathForSession,
} from "../domain/routingModel";
import {
  adapterContextLabel,
  adapterStateLabel,
  cliLaunchLabel,
  isDeployableWorkspaceAdapter,
  isWorkspaceAdapterDeployed,
  isWorkspaceAdapterInstalled,
  workspaceAdapterLaunchable,
  workspaceCleanFeedback,
  workspaceGeneratedNoteCount,
  type LaunchPanelAdapterId,
} from "../domain/workspaceModel";
import {
  actionRequiredCandidate,
  launchPanelPosition,
  shouldProbeCodexActionRequired,
  workspacePanelPosition,
} from "../domain/overlaySessionUi";
import { useBrokerSessions } from "../hooks/useBrokerSessions";
import { useSessionActions } from "../hooks/useSessionActions";
import { useTargetActivation } from "../hooks/useTargetActivation";
import { SessionRowContent, toolDisplayForSession } from "../components/SessionCard";
import {
  BrokerReadinessPanel,
  brokerReadinessLabels,
  type BrokerReadiness,
} from "../components/BrokerReadinessPanel";
import { CandidateMenu, type CandidateMenuState } from "../components/CandidateMenu";
import { CleanConfirmDialog, type CleanConfirmState } from "../components/CleanConfirmDialog";
import { LaunchPanel, type LaunchPanelState } from "../components/LaunchPanel";
import {
  ObsidianVaultRecoveryDialog,
  type ObsidianVaultRecoveryState,
} from "../components/ObsidianVaultRecoveryDialog";
import { WorkspacePanel, type WorkspacePanelState } from "../components/WorkspacePanel";
import { toCliPasteClipboardText, writeClipboardText } from "../native/clipboard";
import {
  applyScratchpadShortcutState,
  loadScratchpadShortcutState,
  saveScratchpadShortcutState,
  type ScratchpadShortcutState,
} from "../native/scratchpadShortcut";
import { type AmoTheme, useAmoThemeRuntime } from "../theme/amoTheme";
import {
  bringUtilityWindowToFront,
  closeUtilityWindow,
  runWithNativeDialogLayer,
  setAmoWindowAlwaysOnTop,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
  type UtilityWindowKind,
  type UtilityWindowStateEvent,
} from "./utilityWindow";
import type {
  ActivationResult,
  AgentSession,
  BrokerDebugStatus,
  ObsidianVaultRegistrationResult,
  OpenPathResult,
  WorkspaceCleanResult,
  WorkspaceGitExcludeResult,
  WorkspaceInspection,
  WorkspaceLaunchResult,
  WorkspaceMaintenanceStatus,
  WorkspacePluginUpdateResult,
} from "../types";

const DEFAULT_OVERLAY_SIZE = { width: 380, height: 520 };
const COLLAPSED_OVERLAY_SIZE = { width: 264, height: 86 };
const OBSIDIAN_PLUGIN_BOOTSTRAP_DELAY_MS = 1200;
const OBSIDIAN_PLUGIN_RELOAD_HINT = "Restart Obsidian or reload the AMO plugin if this vault is already open.";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clipboardPromptForSession(session: AgentSession) {
  const prompt = session.pendingPrompt ?? "";
  const target = targetBindingForSession(session);
  if (target?.type === "codex-app-thread") {
    return prompt;
  }

  return toCliPasteClipboardText(prompt);
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

interface WindowBindDragState {
  sessionId: string;
  pointerId: number;
  pointerX: number;
  pointerY: number;
}

interface ResizeState {
  mode: "vertical" | "horizontal" | "both";
  startScreenX: number;
  startScreenY: number;
  startWidth: number;
  startHeight: number;
}

export function MainOverlayApp() {
  const [amoTheme, setAmoThemePreference] = useAmoThemeRuntime();
  const [attentionVisualSeen, setAttentionVisualSeen] = useState<Record<string, string>>({});
  const [attentionClock, setAttentionClock] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const [openingPath, setOpeningPath] = useState<{ sessionId: string; target: "note" | "canvas" } | null>(null);
  const [, setCopyingPromptId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [sessionSearch, setSessionSearch] = useState("");
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanelState | null>(null);
  const [launchPanel, setLaunchPanel] = useState<LaunchPanelState | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState<CleanConfirmState | null>(null);
  const [obsidianVaultRecovery, setObsidianVaultRecovery] = useState<ObsidianVaultRecoveryState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [scratchpadShortcut, setScratchpadShortcut] = useState<ScratchpadShortcutState>(() =>
    loadScratchpadShortcutState(),
  );
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [windowBindDrag, setWindowBindDrag] = useState<WindowBindDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugCount, setDebugCount] = useState(0);
  const [debugBusy, setDebugBusy] = useState(false);
  const [activeUtilityWindow, setActiveUtilityWindow] = useState<UtilityWindowKind | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const debugEnabledRef = useRef(debugEnabled);
  const debugCountRef = useRef(debugCount);
  const cardDragRef = useRef<CardDragState | null>(null);
  const cardDragCleanupRef = useRef<(() => void) | null>(null);
  const windowBindDragRef = useRef<WindowBindDragState | null>(null);
  const windowBindDragCleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const actionRequiredProbeRef = useRef<Record<string, string>>({});
  const suppressNextClickRef = useRef(false);
  const autoSyncPromptIdsRef = useRef(new Set<string>());
  const reviewTaskbarAttentionActiveRef = useRef(false);
  const {
    brokerReadiness,
    ensureBrokerThenRefresh,
    feedback,
    lastRefreshAt,
    refreshSessions,
    sessionOrder,
    sessions,
    sessionsRef,
    setFeedback,
    setLastRefreshAt,
    setSessionOrder,
    setSessions,
  } = useBrokerSessions({
    autoCopyAndFocusPendingPrompt,
    clearLaunchPanelForSession: (sessionId) =>
      setLaunchPanel((current) => (current?.session.sessionId === sessionId ? null : current)),
    clearSessionMenus: () => {
      setCandidateMenu(null);
      setWorkspacePanel(null);
      setLaunchPanel(null);
    },
    clearWorkspacePanelForSession: (sessionId) =>
      setWorkspacePanel((current) => (current?.session.sessionId === sessionId ? null : current)),
    onStartupRefreshSettled: () => {
      void refreshDebugStatus();
    },
    postDebugLog,
    reconcileCodexActionRequired,
  });

  const {
    archiveSession,
    archivingSessionId,
    clearSessionAttentionAfterActivation,
    clearWindowBinding,
    dismissingSessionId,
    dismissSession,
    markSessionReviewed,
    reviewingSessionId,
    unbindingWindowId,
  } = useSessionActions({
    markSessionVisuallySeen,
    postDebugLog,
    refreshSessions,
    setCandidateMenu,
    setFeedback,
    setLaunchPanel,
    setSessionOrder,
    setSessions,
    setWorkspacePanel,
  });

  const {
    activateCandidate,
    activateSession,
    activatingId,
    bindWindowAtCursor,
    openCodexAppTarget,
    openCodexCliTarget,
  } = useTargetActivation({
    clearSessionAttentionAfterActivation,
    markSessionReviewed,
    markSessionVisuallySeen,
    postDebugLog,
    refreshSessions,
    setCandidateMenu,
    setFeedback,
    setLaunchPanel,
    setSessions,
  });

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

  const activeSessionCount = useMemo(
    () => sessions.filter((session) => !sessionArchived(session)).length,
    [sessions],
  );

  const archiveCount = useMemo(
    () => sessions.filter(sessionArchived).length,
    [sessions],
  );

  const attentionCount = useMemo(
    () => sessions.filter((session) => !sessionArchived(session) && session.needsAttention).length,
    [sessions],
  );

  const reviewCount = useMemo(
    () => sessions.filter((session) => !sessionArchived(session) && sessionNeedsReview(session)).length,
    [sessions],
  );
  const hasAttentionSignal = useMemo(
    () => sessions.some((session) => !sessionArchived(session) && sessionHasAttentionSignal(session)),
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
    const appWindow = getCurrentWindow();
    const hasPendingReview = brokerReady && reviewCount > 0;
    let disposed = false;

    async function requestReviewTaskbarAttention(reason: string) {
      try {
        const focused = await appWindow.isFocused();
        if (disposed || focused) {
          return;
        }

        await appWindow.requestUserAttention(UserAttentionType.Informational);
        reviewTaskbarAttentionActiveRef.current = true;
        void postDebugLog("taskbar.review_attention.requested", {
          reason,
          reviewCount,
        });
      } catch (error) {
        void postDebugLog("taskbar.review_attention.error", {
          reason,
          reviewCount,
          message: (error as Error).message,
        });
      }
    }

    async function clearReviewTaskbarAttention(reason: string) {
      if (!reviewTaskbarAttentionActiveRef.current) {
        return;
      }

      try {
        await appWindow.requestUserAttention(null);
        reviewTaskbarAttentionActiveRef.current = false;
        void postDebugLog("taskbar.review_attention.cleared", {
          reason,
        });
      } catch (error) {
        void postDebugLog("taskbar.review_attention.clear_error", {
          reason,
          message: (error as Error).message,
        });
      }
    }

    if (hasPendingReview) {
      void requestReviewTaskbarAttention("review-count");
    } else {
      void clearReviewTaskbarAttention("review-cleared");
    }

    let unlistenFocus: (() => void) | null = null;
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void clearReviewTaskbarAttention("window-focused");
        } else if (hasPendingReview) {
          void requestReviewTaskbarAttention("window-blurred");
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      })
      .catch((error) => {
        void postDebugLog("taskbar.review_attention.focus_listener_error", {
          message: (error as Error).message,
        });
      });

    return () => {
      disposed = true;
      unlistenFocus?.();
    };
  }, [brokerReady, reviewCount]);

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
    return () => removeWindowBindDragListeners();
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

  async function reconcileCodexActionRequired(candidateSessions: AgentSession[], reason: string) {
    const probeSessions = candidateSessions.filter(shouldProbeCodexActionRequired);
    const probeIds = new Set(probeSessions.map((session) => session.sessionId));
    for (const sessionId of Object.keys(actionRequiredProbeRef.current)) {
      if (!probeIds.has(sessionId)) {
        delete actionRequiredProbeRef.current[sessionId];
      }
    }

    await Promise.all(
      probeSessions.map(async (session) => {
        try {
          const result = await invoke<ActivationResult>(
            "list_session_window_candidates",
            activationWindowRequest(session, windowTargetForSession(session), { includeWindowHintIdentity: true }),
          );
          const candidate = actionRequiredCandidate(result.candidates ?? []);
          if (!candidate) {
            delete actionRequiredProbeRef.current[session.sessionId];
            return;
          }

          const probeKey = `${candidate.hwnd}:${candidate.processId}:${candidate.title}`;
          if (actionRequiredProbeRef.current[session.sessionId] === probeKey) {
            return;
          }
          actionRequiredProbeRef.current[session.sessionId] = probeKey;

          void postDebugLog("codex.action_required.detected", {
            reason,
            sessionId: session.sessionId,
            title: candidate.title,
            hwnd: candidate.hwnd,
            processId: candidate.processId,
          });

          const resultSession = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
            brokerSessionHeartbeatUrl(session.sessionId),
            {
              state: "waiting_permission",
              eventName: "WindowActionRequired",
              message: "Codex CLI is waiting for a local action.",
              needsAttention: true,
              windowHint: {
                process: candidate.processName,
                title: candidate.title,
                project: session.windowHint?.project ?? projectName(session.cwd),
                cwd: session.windowHint?.cwd ?? session.cwd,
                tool: session.windowHint?.tool ?? session.tool,
                pid: candidate.processId,
                hwnd: candidate.hwnd,
                boundAt: session.windowHint?.boundAt ?? null,
                boundBy: session.windowHint?.boundBy ?? "overlay-action-required",
                boundLabel: candidate.label,
              },
            },
          );

          setSessions((previousSessions) => mergeChangedSession(previousSessions, resultSession.session));
        } catch (error) {
          void postDebugLog("codex.action_required.probe_error", {
            reason,
            sessionId: session.sessionId,
            message: (error as Error).message,
          });
        }
      }),
    );
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

  async function openWorkspacePanel(session: AgentSession, x?: number, y?: number) {
    const position = workspacePanelPosition(x, y);
    setCandidateMenu(null);
    setLaunchPanel(null);
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

  async function openLaunchPanel(session: AgentSession, x?: number, y?: number) {
    const position = launchPanelPosition(x, y);
    setCandidateMenu(null);
    setWorkspacePanel(null);
    setLaunchPanel({
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
      setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: "No workspace path is linked to this card." }
          : current,
      );
      return;
    }

    setLaunchPanel((current) =>
      current && current.session.sessionId === session.sessionId ? { ...current, busy: "inspect", error: null } : current,
    );

    try {
      const inspection = await postBrokerJson<WorkspaceInspection>(BROKER_WORKSPACE_INSPECT_URL, {
        workspacePath,
      });
      setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, inspection, busy: null, error: null }
          : current,
      );
      void postDebugLog("workspace.launch_panel.inspect.ok", {
        sessionId: session.sessionId,
        workspacePath: inspection.workspacePath,
      });
    } catch (error) {
      const message = (error as Error).message;
      setLaunchPanel((current) =>
        current && current.session.sessionId === session.sessionId ? { ...current, busy: null, error: message } : current,
      );
      void postDebugLog("workspace.launch_panel.inspect.error", {
        sessionId: session.sessionId,
        workspacePath,
        message,
      });
    }
  }

  async function launchProjectCliFromPanel(adapterId: LaunchPanelAdapterId) {
    if (!launchPanel) return;

    const session = launchPanel.session;
    const workspacePath = launchPanel.inspection?.workspacePath ?? workspacePathForSession(session);
    if (!workspacePath) {
      setLaunchPanel((current) => (current ? { ...current, error: "No workspace path is linked to this card." } : current));
      return;
    }

    if (!workspaceAdapterLaunchable(launchPanel.inspection, adapterId)) {
      setLaunchPanel((current) =>
        current ? { ...current, error: `${cliLaunchLabel(adapterId)} is not deployed in this workspace.` } : current,
      );
      return;
    }

    setLaunchPanel((current) => (current ? { ...current, busy: adapterId, error: null } : current));
    setFeedback(`Launching new ${cliLaunchLabel(adapterId)} for ${projectName(workspacePath)}...`);
    void postDebugLog("workspace.launch_panel.launch.start", {
      sessionId: session.sessionId,
      workspacePath,
      adapterId,
    });

    try {
      const result = await postBrokerJson<WorkspaceLaunchResult>(BROKER_WORKSPACE_LAUNCH_URL, {
        workspacePath,
        adapterId,
      });
      void postDebugLog("workspace.launch_panel.launch.ok", {
        sessionId: session.sessionId,
        workspacePath: result.workspacePath,
        adapterId: result.adapterId,
        pid: result.pid ?? null,
      });
      setFeedback(result.message);
      setLaunchPanel(null);
    } catch (error) {
      const message = (error as Error).message;
      void postDebugLog("workspace.launch_panel.launch.error", {
        sessionId: session.sessionId,
        workspacePath,
        adapterId,
        message,
      });
      setLaunchPanel((current) => (current ? { ...current, busy: null, error: message } : current));
      setFeedback(`Launch failed: ${message}`);
    }
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
      const rawMessage = (error as Error).message;
      const message = /update-obsidian-plugin.+not supported/iu.test(rawMessage)
        ? "AMO broker is still running an older version. Restart AMO, then try Update plugin again."
        : rawMessage;
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

  async function updateWorkspaceObsidianPluginFromPanel() {
    if (!workspacePanel) return;
    const session = workspacePanel.session;
    const workspacePath = workspacePathForSession(session);
    if (!workspacePath) {
      setWorkspacePanel((current) =>
        current ? { ...current, error: "No workspace path is linked to this card." } : current,
      );
      return;
    }

    setWorkspacePanel((current) => (current ? { ...current, busy: "plugin-update", error: null } : current));
    setFeedback(`Updating AMO Obsidian plugin for ${projectName(workspacePath)}...`);
    try {
      const result = await postBrokerJson<WorkspacePluginUpdateResult>(BROKER_WORKSPACE_UPDATE_OBSIDIAN_PLUGIN_URL, {
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
      setFeedback(
        result.after.pluginHealth?.ok
          ? `AMO Obsidian plugin updated to ${result.after.pluginHealth.expectedVersion ?? "expected version"}.`
          : "AMO Obsidian plugin was updated, but the workspace still needs review.",
      );
      void postDebugLog("workspace.maintenance.plugin_update.ok", {
        sessionId: session.sessionId,
        workspacePath,
        pluginHealth: result.after.pluginHealth,
      });
      void refreshSessions("workspace-plugin-update");
    } catch (error) {
      const message = (error as Error).message;
      setWorkspacePanel((current) =>
        current && current.session.sessionId === session.sessionId
          ? { ...current, busy: null, error: message }
          : current,
      );
      setFeedback(`Plugin update failed: ${message}`);
      void postDebugLog("workspace.maintenance.plugin_update.error", {
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

  async function openDeployDialog() {
    await openUtilityWindow("deploy");
  }

  async function openSettingsDialog() {
    await openUtilityWindow("settings");
  }

  async function openUtilityWindow(label: UtilityWindowKind) {
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
      const result = await writeClipboardText(obsidianVaultRecovery.vaultRoot);
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
    const clipboardMode = targetBindingForSession(session)?.type === "codex-app-thread" ? "raw" : "cli-paste";
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
      const result = await writeClipboardText(clipboardPrompt);
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

  function startWindowBindDrag(session: AgentSession, event: PointerEvent<HTMLElement>) {
    const currentTarget = targetBindingForSession(session);
    if (currentTarget && currentTarget.type !== "codex-cli-session") {
      setFeedback("This card already has a target. Unbind it before dragging to a different window.");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the button is remounted while the card updates.
    }

    const nextDrag = {
      sessionId: session.sessionId,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    windowBindDragRef.current = nextDrag;
    suppressNextClickRef.current = true;
    setWindowBindDrag(nextDrag);
    setFeedback(`Drag to the target CLI/app window and release to bind ${session.title}.`);
    attachWindowBindDragListeners(event.pointerId);
  }

  function attachWindowBindDragListeners(pointerId: number) {
    removeWindowBindDragListeners();

    const handleMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      continueWindowBindDragAt(event.clientX, event.clientY);
    };

    const handleEnd = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      void finishWindowBindDrag();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd, { passive: false });
    window.addEventListener("pointercancel", handleEnd, { passive: false });
    windowBindDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  }

  function removeWindowBindDragListeners() {
    windowBindDragCleanupRef.current?.();
    windowBindDragCleanupRef.current = null;
  }

  function continueWindowBindDragAt(pointerX: number, pointerY: number) {
    const activeDrag = windowBindDragRef.current;
    if (!activeDrag) {
      return;
    }

    const nextDrag = {
      ...activeDrag,
      pointerX,
      pointerY,
    };
    windowBindDragRef.current = nextDrag;
    setWindowBindDrag(nextDrag);
  }

  async function finishWindowBindDrag() {
    const activeDrag = windowBindDragRef.current;
    if (!activeDrag) {
      return;
    }

    removeWindowBindDragListeners();
    windowBindDragRef.current = null;
    setWindowBindDrag(null);

    const session = sessionsRef.current.find((item) => item.sessionId === activeDrag.sessionId);
    if (!session) {
      setFeedback("The card is no longer available.");
      return;
    }

    const currentTarget = targetBindingForSession(session);
    if (currentTarget && currentTarget.type !== "codex-cli-session") {
      setFeedback("This card already has a target binding.");
      return;
    }

    await bindWindowAtCursor(session);
  }

  async function handleSessionAttention(session: AgentSession) {
    const clearedSession = await clearSessionAttentionAfterActivation(session, "manual-handle");
    await activateSession(clearedSession ?? session);
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
              {lastRefreshAt ? ` 鐠?${formatAgo(lastRefreshAt)} ago` : ""}
              {debugEnabled ? ` 鐠?debug ${debugCount}` : ""}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`icon-button ${activeUtilityWindow === "settings" ? "is-active" : ""}`}
            title="Open settings"
            onClick={() => {
              void openSettingsDialog();
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
          <span>{brokerReady ? `${activeSessionCount} sessions` : brokerReadinessLabels[brokerReadiness.state]}</span>
          <strong>
            {brokerReady
              ? `${attentionCount} attention${reviewCount > 0 ? ` 鐠?${reviewCount} review` : ""}`
              : brokerReadiness.message}
          </strong>
        </button>
      ) : (
        <>
          <section className="summary-strip" aria-label="Session summary">
            <div className="summary-info">
              {brokerReady ? (
                <>
                  <span>{activeSessionCount} active lines</span>
                  <strong>{attentionCount} need attention</strong>
                  {reviewCount > 0 ? <strong className="summary-review">{reviewCount} review</strong> : null}
                  {archiveCount > 0 ? <em>{archiveCount} archive</em> : null}
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
                {(["all", "attention", "idle", "archive"] as SessionFilter[]).map((filter) => (
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
                    {filter === "archive" ? <Archive size={12} aria-hidden="true" /> : null}
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
                  archiving={archivingSessionId === session.sessionId}
                  reviewing={reviewingSessionId === session.sessionId}
                  dismissing={dismissingSessionId === session.sessionId}
                  attentionSignal={sessionHasAttentionSignal(session)}
                  attentionVisualActive={isSessionVisualAttentionActive(session)}
                  onOpenNote={() => void openBridgePath(session, "note")}
                  onOpenCanvas={() => void openBridgePath(session, "canvas")}
                  onMarkReviewed={() => void markSessionReviewed(session, "manual")}
                  onUnbindWindow={() => void clearWindowBinding(session)}
                  onArchive={() => void archiveSession(session)}
                  onDismiss={() => void dismissSession(session)}
                  onOpenCodexAppTarget={() => void openCodexAppTarget(session, true)}
                  onActivateSession={() => void activateSession(session)}
                  onHandleAttention={() => void handleSessionAttention(session)}
                  onOpenLaunchPanel={(x, y) => void openLaunchPanel(session, x, y)}
                  onOpenWorkspacePanel={(x, y) => void openWorkspacePanel(session, x, y)}
                  onStartWindowBindDrag={(event) => startWindowBindDrag(session, event)}
                  windowBindDragging={windowBindDrag?.sessionId === session.sessionId}
                />
              </div>
            )) : (
              <div className="session-empty-state">
                No matching cards.
              </div>
            )}
          </section>

          {candidateMenu ? (
            <CandidateMenu
              state={candidateMenu}
              activating={activatingId === candidateMenu.session.sessionId}
              onClose={() => setCandidateMenu(null)}
              onBindOnSelectChange={(checked) =>
                setCandidateMenu((current) => (current ? { ...current, bindOnSelect: checked } : current))
              }
              onSelectCandidate={(selectedCandidateKey) =>
                setCandidateMenu((current) => (current ? { ...current, selectedCandidateKey } : current))
              }
              onOpenCodexAppTarget={() =>
                void openCodexAppTarget(candidateMenu.session, candidateMenu.bindOnSelect, {
                  clearAttentionOnSuccess: candidateMenu.clearAttentionOnConfirm,
                })
              }
              onOpenCodexCliTarget={() =>
                void openCodexCliTarget(candidateMenu.session, candidateMenu.bindOnSelect, {
                  clearAttentionOnSuccess: candidateMenu.clearAttentionOnConfirm,
                })
              }
              onFocusCandidate={(candidate) =>
                void activateCandidate(candidateMenu.session, candidate, false, {
                  closeOnSuccess: false,
                  clearAttentionOnSuccess: false,
                  markReviewedOnSuccess: false,
                })
              }
              onConfirmCandidate={(candidate) =>
                void activateCandidate(candidateMenu.session, candidate, candidateMenu.bindOnSelect, {
                  clearAttentionOnSuccess: candidateMenu.clearAttentionOnConfirm,
                })
              }
            />
          ) : null}
          {launchPanel ? (
            <LaunchPanel
              state={launchPanel}
              onClose={() => setLaunchPanel(null)}
              onLaunch={(adapterId) => void launchProjectCliFromPanel(adapterId)}
            />
          ) : null}
          {workspacePanel ? (
            <WorkspacePanel
              state={workspacePanel}
              onClose={() => setWorkspacePanel(null)}
              onTaskTitleDraftChange={(taskTitleDraft) =>
                setWorkspacePanel((current) => (current ? { ...current, taskTitleDraft } : current))
              }
              onSaveTaskTitle={(overrideTaskTitle) => void saveWorkspacePanelTaskTitle(overrideTaskTitle)}
              onLoadStatus={() => void loadWorkspaceStatus(workspacePanel.session)}
              onOpenPath={(path, label) => void openMaintenancePath(path, label)}
              onRequestClean={() => requestCleanWorkspaceVault()}
              onUpdatePlugin={() => void updateWorkspaceObsidianPluginFromPanel()}
            />
          ) : null}
          {obsidianVaultRecovery ? (
            <ObsidianVaultRecoveryDialog
              state={obsidianVaultRecovery}
              onClose={() => setObsidianVaultRecovery(null)}
              onOpenFolder={() => void openRecoveryVaultFolder()}
              onCopyPath={() => void copyRecoveryVaultPath()}
            />
          ) : null}

          {cleanConfirm ? (
            <CleanConfirmDialog
              state={cleanConfirm}
              onClose={() => setCleanConfirm(null)}
              onConfirm={() => void cleanWorkspaceVaultFromPanel()}
            />
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
                    archiving={false}
                    reviewing={reviewingSessionId === session.sessionId}
                    dismissing={dismissingSessionId === session.sessionId}
                    attentionSignal={sessionHasAttentionSignal(session)}
                    attentionVisualActive={isSessionVisualAttentionActive(session)}
                    onOpenNote={() => undefined}
                    onOpenCanvas={() => undefined}
                    onMarkReviewed={() => undefined}
                    onUnbindWindow={() => undefined}
                    onArchive={() => undefined}
                    onDismiss={() => undefined}
                    onOpenCodexAppTarget={() => undefined}
                    onActivateSession={() => undefined}
                    onHandleAttention={() => undefined}
                    onOpenLaunchPanel={() => undefined}
                    onOpenWorkspacePanel={() => undefined}
                    onStartWindowBindDrag={() => undefined}
                    windowBindDragging={false}
                  />
                ) : null;
              })()}
            </div>
          ) : null}

          {windowBindDrag ? (
            <div
              className="window-bind-drag-chip"
              style={{
                left: windowBindDrag.pointerX + 12,
                top: windowBindDrag.pointerY + 12,
              }}
            >
              Drop on target window
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

    </main>
  );
}

export default MainOverlayApp;
