import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Blocks,
  Bot,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GripHorizontal,
  GripVertical,
  Minimize2,
  RefreshCcw,
  SquareTerminal,
} from "lucide-react";
import { mockSessions } from "./mockSessions";
import type {
  ActivationResult,
  AgentSession,
  AgentTool,
  ObsidianWindowTarget,
  SessionState,
} from "./types";

const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
const OBSIDIAN_TEST_VAULT_PATH = "D:\\Projects\\commonproject\\AgentMonitorOverlay-obsidian-test-vault";
const REFRESH_INTERVAL_MS = 3000;
const OBSIDIAN_TARGET_STORAGE_KEY = "amo.obsidianTargetHwnd";

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

const toolLabel: Record<AgentTool, string> = {
  codex: "Codex",
  claude: "Claude",
  kiro: "Kiro",
  other: "Agent",
};

const toolIcon = {
  codex: SquareTerminal,
  claude: BrainCircuit,
  kiro: Blocks,
  other: Bot,
} satisfies Record<AgentTool, typeof SquareTerminal>;

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
  pointerY: number;
  offsetY: number;
  left: number;
  width: number;
  height: number;
}

function ToolMark({ tool, state }: { tool: AgentTool; state: SessionState }) {
  const Icon = toolIcon[tool] ?? toolIcon.other;

  return (
    <span className={`tool-mark tool-${tool}`} title={toolLabel[tool] ?? toolLabel.other}>
      <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
      <span className="state-dot" aria-label={stateLabel[state]} />
    </span>
  );
}

function SessionRowContent({
  session,
  activating,
  openingNote,
  onOpenNote,
}: {
  session: AgentSession;
  activating: boolean;
  openingNote: boolean;
  onOpenNote: () => void;
}) {
  return (
    <>
      <ToolMark tool={session.tool} state={session.state} />
      <span className="session-main">
        <span className="session-line">
          <strong>{projectName(session.cwd)}</strong>
          <span>{session.tool}</span>
          <em>{formatAgo(session.updatedAt)}</em>
        </span>
        <span className="message-line">{session.lastMessage}</span>
        <span className="event-line">
          {stateLabel[session.state]} · {session.lastEvent}
        </span>
      </span>
      <span className="row-actions">
        <button
          type="button"
          className="row-icon-button"
          title="Create/open linked Obsidian note"
          disabled={openingNote}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenNote();
          }}
        >
          {openingNote ? "..." : <BookOpen size={14} aria-hidden="true" />}
        </button>
        <span className="row-action" aria-hidden="true" title="Activate session window">
          {activating ? "..." : <ExternalLink size={15} />}
        </span>
      </span>
    </>
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
  const [openingNoteId, setOpeningNoteId] = useState<string | null>(null);
  const [obsidianTargets, setObsidianTargets] = useState<ObsidianWindowTarget[]>([]);
  const [obsidianPickerOpen, setObsidianPickerOpen] = useState(false);
  const [loadingObsidianTargets, setLoadingObsidianTargets] = useState(false);
  const [selectedObsidianHwnd, setSelectedObsidianHwnd] = useState<number | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const raw = window.localStorage.getItem(OBSIDIAN_TARGET_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sessionsRef = useRef(sessions);
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const cardDragRef = useRef<CardDragState | null>(null);
  const suppressNextClickRef = useRef(false);

  const orderedSessions = useMemo(
    () => applySessionOrder(sessions, sessionOrder).slice(0, 8),
    [sessions, sessionOrder],
  );
  const selectedObsidianTarget = useMemo(
    () => obsidianTargets.find((target) => target.hwnd === selectedObsidianHwnd) ?? null,
    [obsidianTargets, selectedObsidianHwnd],
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

  function selectObsidianTarget(target: ObsidianWindowTarget) {
    setSelectedObsidianHwnd(target.hwnd);
    window.localStorage.setItem(OBSIDIAN_TARGET_STORAGE_KEY, String(target.hwnd));
    setObsidianPickerOpen(false);
    setFeedback(`Bound Obsidian target: ${target.title}`);
  }

  async function loadObsidianTargets() {
    setLoadingObsidianTargets(true);

    try {
      const targets = await invoke<ObsidianWindowTarget[]>("list_obsidian_windows");
      setObsidianTargets(targets);
      setObsidianPickerOpen(true);

      if (selectedObsidianHwnd && !targets.some((target) => target.hwnd === selectedObsidianHwnd)) {
        setSelectedObsidianHwnd(null);
        window.localStorage.removeItem(OBSIDIAN_TARGET_STORAGE_KEY);
      }

      setFeedback(
        targets.length > 0
          ? `Found ${targets.length} Obsidian window target(s).`
          : "No visible Obsidian windows found. Open the target vault first.",
      );
    } catch (error) {
      setFeedback(`Listing Obsidian windows failed: ${(error as Error).message}`);
    } finally {
      setLoadingObsidianTargets(false);
    }
  }

  async function activateSession(session: AgentSession) {
    setActivatingId(session.sessionId);
    setFeedback(`Activating ${session.title}...`);

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
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Activation command failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function openObsidianNote(session: AgentSession) {
    setOpeningNoteId(session.sessionId);
    setFeedback(`Creating Obsidian note for ${session.title}...`);

    try {
      const result = await invoke<ActivationResult>("create_or_open_obsidian_note", {
        vaultPath: OBSIDIAN_TEST_VAULT_PATH,
        sessionId: session.sessionId,
        tool: session.tool,
        cwd: session.cwd,
        project: session.windowHint?.project ?? projectName(session.cwd),
        title: session.title,
        state: session.state,
        lastEvent: session.lastEvent,
        lastMessage: session.lastMessage,
        updatedAt: session.updatedAt,
        windowTitle: session.windowHint?.title ?? session.title,
        windowProcess: session.windowHint?.process ?? "",
        windowPid: session.windowHint?.pid ?? null,
        windowHwnd: session.windowHint?.hwnd ?? null,
        obsidianTitle: selectedObsidianTarget?.title ?? "",
        obsidianProcess: selectedObsidianTarget?.processName ?? "",
        obsidianPid: selectedObsidianTarget?.processId ?? null,
        obsidianHwnd: selectedObsidianTarget?.hwnd ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Obsidian note command failed: ${(error as Error).message}`);
    } finally {
      setOpeningNoteId(null);
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
    event.currentTarget.setPointerCapture(event.pointerId);

    const rect = row.getBoundingClientRect();
    const nextDrag = {
      sessionId: session.sessionId,
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
  }

  function continueCardDrag(event: PointerEvent<HTMLElement>) {
    const activeDrag = cardDragRef.current;
    if (!activeDrag) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextDrag = {
      ...activeDrag,
      pointerY: event.clientY,
    };
    cardDragRef.current = nextDrag;
    setCardDrag(nextDrag);
    updateCardDrag(event.clientY);
  }

  function endCardDrag(event: PointerEvent<HTMLElement>) {
    if (!cardDragRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cardDragRef.current = null;
    setCardDrag(null);
    setDropTargetId(null);
  }

  useEffect(() => {
    void refreshSessions();
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
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="chip-button"
            title="Select Obsidian target window"
            onClick={() => void loadObsidianTargets()}
          >
            <BookOpen size={14} aria-hidden="true" />
            <span>{loadingObsidianTargets ? "Scanning" : "Obsidian"}</span>
          </button>
          <button type="button" className="icon-button" title="Refresh sessions" onClick={refreshSessions}>
            <RefreshCcw size={15} aria-hidden="true" />
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

          <section className="obsidian-strip" aria-label="Obsidian target binding">
            <div className="obsidian-strip-line">
              <strong>Obsidian target</strong>
              <span>{selectedObsidianTarget ? selectedObsidianTarget.title : "Not selected"}</span>
            </div>
            {obsidianPickerOpen ? (
              <div className="obsidian-picker">
                {obsidianTargets.length === 0 ? (
                  <span className="obsidian-empty">No visible Obsidian windows</span>
                ) : (
                  obsidianTargets.map((target) => (
                    <button
                      key={target.hwnd}
                      type="button"
                      className={`obsidian-target-button ${
                        selectedObsidianTarget?.hwnd === target.hwnd ? "is-selected" : ""
                      }`}
                      onClick={() => selectObsidianTarget(target)}
                    >
                      <strong>{target.title || "(untitled Obsidian window)"}</strong>
                      <span>
                        pid {target.processId} · hwnd 0x{target.hwnd.toString(16).toUpperCase()}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </section>

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
                onClick={() => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    return;
                  }

                  void activateSession(session);
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
                  onPointerMove={continueCardDrag}
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
                  openingNote={openingNoteId === session.sessionId}
                  onOpenNote={() => void openObsidianNote(session)}
                />
              </div>
            ))}
          </section>

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
                    openingNote={openingNoteId === session.sessionId}
                    onOpenNote={() => undefined}
                  />
                ) : null;
              })()}
            </div>
          ) : null}

          <footer className="feedback-line" title={feedback}>
            {feedback}
          </footer>
        </>
      )}
    </main>
  );
}
