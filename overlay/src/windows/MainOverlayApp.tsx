import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Clock,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  ListFilter,
  Search,
  Settings2,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  applySessionOrder,
  sessionArchived,
  sessionFilterLabels,
  formatAgo,
  sessionHasAttentionSignal,
  sessionMatchesFilter,
  sessionNeedsReview,
  type SessionFilter,
} from "../domain/sessionModel";
import { projectName, targetBindingForSession } from "../domain/routingModel";
import { useCodexActionRequiredProbe } from "../hooks/useCodexActionRequiredProbe";
import { useDebugLogging } from "../hooks/useDebugLogging";
import { useBrokerSessions } from "../hooks/useBrokerSessions";
import { useAttentionVisuals } from "../hooks/useAttentionVisuals";
import { useCardDrag } from "../hooks/useCardDrag";
import { useMainUtilityWindows } from "../hooks/useMainUtilityWindows";
import { useManagedWindowLiveness } from "../hooks/useManagedWindowLiveness";
import { useObsidianOpen } from "../hooks/useObsidianOpen";
import { useOverlayResize } from "../hooks/useOverlayResize";
import { usePendingPromptSync } from "../hooks/usePendingPromptSync";
import { useSessionActions } from "../hooks/useSessionActions";
import { useTargetActivation } from "../hooks/useTargetActivation";
import { useWindowBindDrag } from "../hooks/useWindowBindDrag";
import { useWindowsNotifications } from "../hooks/useWindowsNotifications";
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
import {
  applyScratchpadShortcutState,
  loadScratchpadShortcutState,
} from "../native/scratchpadShortcut";
import { listenForTrayOpenRequests, setTrayAttentionState } from "../native/tray";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import type {
  AgentSession,
} from "../types";

const DEFAULT_OVERLAY_SIZE = { width: 380, height: 520 };
const COLLAPSED_OVERLAY_SIZE = { width: 264, height: 52 };

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
  useAmoThemeRuntime();
  const [collapsed, setCollapsed] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [sessionSearch, setSessionSearch] = useState("");
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanelState | null>(null);
  const [launchPanel, setLaunchPanel] = useState<LaunchPanelState | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState<CleanConfirmState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const actionRequiredProbeHandlerRef = useRef<((candidateSessions: AgentSession[], reason: string) => Promise<void>) | null>(null);
  const suppressNextClickRef = useRef(false);
  const pendingPromptSyncRef = useRef<((session: AgentSession, reason: string) => void) | null>(null);
  const collapsedRef = useRef(false);
  const {
    attachFeedbackSetter,
    postDebugLog,
    refreshDebugStatus,
  } = useDebugLogging();
  const {
    brokerReadiness,
    ensureBrokerThenRefresh,
    feedback,
    hasLoadedSessionSnapshot,
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
  attachFeedbackSetter(setFeedback);

  useEffect(() => {
    void invoke("signal_frontend_ready").catch(() => {
      // Browser preview does not expose the native smoke command.
    });
  }, []);

  const {
    reconcileCodexActionRequired: handleCodexActionRequiredProbe,
  } = useCodexActionRequiredProbe({
    postDebugLog,
    setSessions,
  });
  actionRequiredProbeHandlerRef.current = handleCodexActionRequiredProbe;

  const brokerReady = brokerReadiness.state === "ready";
  useManagedWindowLiveness({
    brokerReady,
    postDebugLog,
    sessions,
    setSessions,
  });
  const reviewCount = useMemo(
    () => sessions.filter((session) => !sessionArchived(session) && sessionNeedsReview(session)).length,
    [sessions],
  );

  const {
    isSessionVisualAttentionActive,
    isSessionVisuallySeen,
    markSessionVisuallySeen,
  } = useAttentionVisuals({
    brokerReady,
    postDebugLog,
    sessions,
  });

  const {
    activeUtilityWindow,
    focusUtilityWindow,
    hideUtilityWindow,
    openDeployDialog,
    openSettingsDialog,
  } = useMainUtilityWindows({
    setFeedback,
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
    resumeManagedSession,
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
    autoCopyAndFocusPendingPrompt: handleAutoCopyAndFocusPendingPrompt,
  } = usePendingPromptSync({
    activateSession,
    postDebugLog,
    refreshSessions,
    setFeedback,
  });
  pendingPromptSyncRef.current = handleAutoCopyAndFocusPendingPrompt;

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

  const attentionSignalCount = useMemo(
    () => sessions.filter((session) => !sessionArchived(session) && sessionHasAttentionSignal(session)).length,
    [sessions],
  );

  useWindowsNotifications({
    brokerReady: brokerReady && hasLoadedSessionSnapshot,
    postDebugLog,
    sessions,
  });

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    orderedSessionsRef.current = orderedSessions;
  }, [orderedSessions]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    void setTrayAttentionState(attentionSignalCount > 0).catch((error) => {
      postDebugLog("tray.attention_state.error", {
        attention: attentionSignalCount > 0,
        message: (error as Error).message,
      });
    });
  }, [attentionSignalCount]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenForTrayOpenRequests((request) => {
      if (request.expand && collapsedRef.current) {
        void setOverlayCollapsed(false);
      }
      if (request.selectAttentionFilter) {
        setSessionSearch("");
        setSessionFilter("attention");
      }
    }).then((handler) => {
      if (disposed) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const scratchpadShortcut = loadScratchpadShortcutState();
    void applyScratchpadShortcutState(scratchpadShortcut).catch((error) => {
      setFeedback(`Scratchpad shortcut setup failed: ${(error as Error).message}`);
    });
  }, []);

  async function reconcileCodexActionRequired(candidateSessions: AgentSession[], reason: string) {
    await actionRequiredProbeHandlerRef.current?.(candidateSessions, reason);
  }

  async function setOverlayCollapsed(nextCollapsed: boolean) {
    collapsedRef.current = nextCollapsed;
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

  function toggleCollapsed() {
    void setOverlayCollapsed(!collapsedRef.current);
  }

  function autoCopyAndFocusPendingPrompt(session: AgentSession, reason: string) {
    pendingPromptSyncRef.current?.(session, reason);
  }

  async function handleSessionAttention(session: AgentSession) {
    const clearedSession = await clearSessionAttentionAfterActivation(session, "manual-handle");
    await activateSession(clearedSession ?? session);
  }

  return (
    <main className={`overlay-shell ${collapsed ? "is-collapsed" : ""}`}>
      <header
        className={`overlay-header ${collapsed ? "is-collapsed" : ""}`}
        data-tauri-drag-region
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }

          void getCurrentWindow().startDragging().catch(() => undefined);
        }}
      >
        {collapsed ? (
          <>
            <div className="collapsed-counts" data-tauri-drag-region aria-label="Collapsed session summary">
              <span data-tauri-drag-region>
                <strong>{activeSessionCount}</strong> active
              </span>
              <span className={attentionSignalCount > 0 ? "has-attention" : ""} data-tauri-drag-region>
                <strong>{attentionSignalCount}</strong> need attention
              </span>
            </div>
            <button type="button" className="icon-button" title="Expand overlay" aria-label="Expand overlay" onClick={toggleCollapsed}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <div className="header-title" data-tauri-drag-region>
              <GripHorizontal size={16} aria-hidden="true" />
              <div data-tauri-drag-region>
                <strong>Agents</strong>
                <span>
                  {brokerReadinessLabels[brokerReadiness.state]}
                  {lastRefreshAt ? ` | ${formatAgo(lastRefreshAt)} ago` : ""}
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
                className={`icon-button ${activeUtilityWindow === "deploy" ? "is-active" : ""}`}
                title="Open deploy window"
                onClick={() => {
                  void openDeployDialog();
                }}
              >
                <FolderPlus size={15} aria-hidden="true" />
              </button>
              <button type="button" className="icon-button" title="Collapse overlay" aria-label="Collapse overlay" onClick={toggleCollapsed}>
                <ChevronUp size={16} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
      </header>

      {!collapsed ? (
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
                  onResumeSession={() => void resumeManagedSession(session)}
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
              onResumeManagedCli={() => void resumeManagedSession(candidateMenu.session)}
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
                    onResumeSession={() => undefined}
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
      ) : null}

    </main>
  );
}

export default MainOverlayApp;
