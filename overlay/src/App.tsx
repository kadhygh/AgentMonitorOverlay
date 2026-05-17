import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Blocks,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  GripHorizontal,
  GripVertical,
  Map as MapIcon,
  Minimize2,
  RefreshCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import { mockSessions } from "./mockSessions";
import type {
  ActivationCandidate,
  ActivationResult,
  AgentSession,
  AgentTool,
  OpenPathResult,
  SessionState,
} from "./types";

const BROKER_SESSIONS_URL = "http://127.0.0.1:17654/api/sessions";
const REFRESH_INTERVAL_MS = 3000;

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

function obsidianOpenUri(path: string) {
  return `obsidian://open?path=${encodeURIComponent(path)}&paneType=tab`;
}

function shortPathLabel(value: string | undefined) {
  if (!value) {
    return "";
  }

  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
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
}

interface ResizeState {
  mode: "vertical" | "horizontal" | "both";
  startScreenX: number;
  startScreenY: number;
  startWidth: number;
  startHeight: number;
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
  openingTarget,
  onOpenNote,
  onOpenCanvas,
}: {
  session: AgentSession;
  activating: boolean;
  openingTarget: "note" | "canvas" | null;
  onOpenNote: () => void;
  onOpenCanvas: () => void;
}) {
  const notePath = notePathForOpen(session);
  const canvasPath = canvasPathForOpen(session);

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
        {notePath || canvasPath ? (
          <span className="bridge-actions" aria-label="Bridge actions">
            {notePath ? (
              <button
                type="button"
                className="row-tool-button"
                title={`Open note: ${session.lastReplyNote ?? notePath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenNote();
                }}
              >
                <FileText size={13} aria-hidden="true" />
                <span>{openingTarget === "note" ? "..." : shortPathLabel(session.lastReplyNote) || "Note"}</span>
              </button>
            ) : null}
            {canvasPath ? (
              <button
                type="button"
                className="row-tool-button"
                title={`Open canvas: ${session.canvasPath ?? canvasPath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCanvas();
                }}
              >
                <MapIcon size={13} aria-hidden="true" />
                <span>{openingTarget === "canvas" ? "..." : shortPathLabel(session.canvasPath) || "Canvas"}</span>
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="row-action" aria-hidden="true">
        {activating ? "..." : <ExternalLink size={15} />}
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
  const [openingPath, setOpeningPath] = useState<{ sessionId: string; target: "note" | "canvas" } | null>(null);
  const [candidateMenu, setCandidateMenu] = useState<CandidateMenuState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sessionsRef = useRef(sessions);
  const orderedSessionsRef = useRef<AgentSession[]>([]);
  const cardDragRef = useRef<CardDragState | null>(null);
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

  async function activateSession(session: AgentSession, menuX?: number, menuY?: number) {
    setActivatingId(session.sessionId);
    setCandidateMenu(null);
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
      if (!result.ok && result.candidates && result.candidates.length > 1) {
        const position = menuPosition(menuX, menuY);
        setCandidateMenu({
          session,
          candidates: result.candidates,
          x: position.x,
          y: position.y,
        });
      }
      setFeedback(result.message);
    } catch (error) {
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

    try {
      const result = await invoke<OpenPathResult>("open_uri", { uri: obsidianOpenUri(targetPath) });
      if (result.ok) {
        setFeedback(`${target === "note" ? "Note" : "Canvas"} opened in Obsidian.`);
      } else {
        setFeedback(result.message);
      }
    } catch (error) {
      setFeedback(`Open ${target} failed: ${(error as Error).message}`);
    } finally {
      setOpeningPath(null);
    }
  }

  async function activateCandidate(session: AgentSession, candidate: ActivationCandidate) {
    setActivatingId(session.sessionId);
    setFeedback(`Activating ${candidate.processName ?? "window"}...`);

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
      if (result.ok) {
        setCandidateMenu(null);
      }
    } catch (error) {
      setFeedback(`Candidate activation failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
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
                  openingTarget={openingPath?.sessionId === session.sessionId ? openingPath.target : null}
                  onOpenNote={() => void openBridgePath(session, "note")}
                  onOpenCanvas={() => void openBridgePath(session, "canvas")}
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
              <div className="candidate-list">
                {candidateMenu.candidates.map((candidate) => (
                  <button
                    type="button"
                    className="candidate-item"
                    key={`${candidate.hwnd}-${candidate.processId}`}
                    title={candidate.label}
                    onClick={() => void activateCandidate(candidateMenu.session, candidate)}
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
                    onOpenNote={() => undefined}
                    onOpenCanvas={() => undefined}
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
