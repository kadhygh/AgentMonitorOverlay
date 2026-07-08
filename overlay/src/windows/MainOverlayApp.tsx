import { useEffect, useMemo, useRef, useState } from "react";
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
  BROKER_SYNC_BACK_URL,
  brokerSessionHeartbeatUrl,
  postBrokerJson,
} from "../api/brokerClient";
import {
  applySessionOrder,
  mergeChangedSession,
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
  projectName,
  targetBindingForSession,
  windowTargetForSession,
} from "../domain/routingModel";
import {
  actionRequiredCandidate,
  shouldProbeCodexActionRequired,
} from "../domain/overlaySessionUi";
import { useBrokerSessions } from "../hooks/useBrokerSessions";
import { useCardDrag } from "../hooks/useCardDrag";
import { useObsidianOpen } from "../hooks/useObsidianOpen";
import { useOverlayResize } from "../hooks/useOverlayResize";
import { useSessionActions } from "../hooks/useSessionActions";
import { useTargetActivation } from "../hooks/useTargetActivation";
import { useWindowBindDrag } from "../hooks/useWindowBindDrag";
import { useWorkspacePanels } from "../hooks/useWorkspacePanels";
import { SessionRowContent, toolDisplayForSession } from "../components/SessionCard";
import {
  BrokerReadinessPanel,
  brokerReadinessLabels,
  type BrokerReadiness,
} from "../components/BrokerReadinessPanel";
import { CandidateMenu, type CandidateMenuState } from "../components/CandidateMenu";
import { CleanConfirmDialog, type CleanConfirmState } from "../components/CleanConfirmDialog";
import { LaunchPanel, type LaunchPanelState } from "../components/LaunchPanel";
import { ObsidianVaultRecoveryDialog } from "../components/ObsidianVaultRecoveryDialog";
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
  OpenPathResult,
} from "../types";

const DEFAULT_OVERLAY_SIZE = { width: 380, height: 520 };
const COLLAPSED_OVERLAY_SIZE = { width: 264, height: 86 };

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

export function MainOverlayApp() {
  const [amoTheme, setAmoThemePreference] = useAmoThemeRuntime();
  const [attentionVisualSeen, setAttentionVisualSeen] = useState<Record<string, string>>({});
  const [attentionClock, setAttentionClock] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const [, setCopyingPromptId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [sessionSearch, setSessionSearch] = useState("");
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanelState | null>(null);
  const [launchPanel, setLaunchPanel] = useState<LaunchPanelState | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState<CleanConfirmState | null>(null);
  const [scratchpadShortcut, setScratchpadShortcut] = useState<ScratchpadShortcutState>(() =>
    loadScratchpadShortcutState(),
  );
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugCount, setDebugCount] = useState(0);
  const [debugBusy, setDebugBusy] = useState(false);
  const [activeUtilityWindow, setActiveUtilityWindow] = useState<UtilityWindowKind | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const debugEnabledRef = useRef(debugEnabled);
  const debugCountRef = useRef(debugCount);
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
    cardDrag,
    dropTargetId,
    endCardDrag,
    startCardDrag,
  } = useCardDrag({
    orderedSessionsRef,
    rowRefs,
    sessionsRef,
    setFeedback,
    setSessionOrder,
    suppressNextClickRef,
  });

  const {
    continueWindowResize,
    endWindowResize,
    isResizing,
    startWindowResize,
  } = useOverlayResize({
    collapsed,
    setFeedback,
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

  const {
    startWindowBindDrag,
    windowBindDrag,
  } = useWindowBindDrag({
    bindWindowAtCursor,
    sessionsRef,
    setFeedback,
    suppressNextClickRef,
  });

  const {
    closeObsidianVaultRecovery,
    copyRecoveryVaultPath,
    obsidianVaultRecovery,
    openBridgePath,
    openingPath,
    openRecoveryVaultFolder,
  } = useObsidianOpen({
    markSessionReviewed,
    markSessionVisuallySeen,
    postDebugLog,
    setFeedback,
  });

  const {
    cleanWorkspaceVaultFromPanel,
    launchProjectCliFromPanel,
    loadWorkspaceStatus,
    openLaunchPanel,
    openMaintenancePath,
    openWorkspacePanel,
    requestCleanWorkspaceVault,
    saveWorkspacePanelTaskTitle,
    updateWorkspaceObsidianPluginFromPanel,
  } = useWorkspacePanels({
    launchPanel,
    postDebugLog,
    refreshSessions,
    setCandidateMenu,
    setCleanConfirm,
    setFeedback,
    setLaunchPanel,
    setSessions,
    setWorkspacePanel,
    workspacePanel,
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

  async function handleSessionAttention(session: AgentSession) {
    const clearedSession = await clearSessionAttentionAfterActivation(session, "manual-handle");
    await activateSession(clearedSession ?? session);
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
              onClose={closeObsidianVaultRecovery}
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
