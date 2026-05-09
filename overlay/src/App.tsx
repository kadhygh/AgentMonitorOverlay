import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Blocks,
  Bot,
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
import type { ActivationResult, AgentSession, AgentTool, SessionState } from "./types";

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

function ToolMark({ tool, state }: { tool: AgentTool; state: SessionState }) {
  const Icon = toolIcon[tool] ?? toolIcon.other;

  return (
    <span className={`tool-mark tool-${tool}`} title={toolLabel[tool] ?? toolLabel.other}>
      <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
      <span className="state-dot" aria-label={stateLabel[state]} />
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
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const orderedSessions = useMemo(
    () => applySessionOrder(sessions, sessionOrder).slice(0, 8),
    [sessions, sessionOrder],
  );

  const attentionCount = useMemo(
    () => sessions.filter((session) => session.needsAttention).length,
    [sessions],
  );

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

  function moveSessionBefore(targetSession: AgentSession) {
    if (!draggingSessionId || draggingSessionId === targetSession.sessionId) {
      return;
    }

    const draggedSession = sessions.find((session) => session.sessionId === draggingSessionId);

    setSessionOrder((previousOrder) => {
      const baseOrder = mergeSessionOrder(previousOrder, sessions);
      const fromIndex = baseOrder.indexOf(draggingSessionId);
      const toIndex = baseOrder.indexOf(targetSession.sessionId);
      if (fromIndex < 0 || toIndex < 0) {
        return baseOrder;
      }

      const nextOrder = [...baseOrder];
      const [movedId] = nextOrder.splice(fromIndex, 1);
      const insertIndex = nextOrder.indexOf(targetSession.sessionId);
      nextOrder.splice(insertIndex, 0, movedId);
      return nextOrder;
    });

    setFeedback(
      `Moved ${draggedSession?.title ?? draggingSessionId} before ${targetSession.title}.`,
    );
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
                className={`session-row state-${session.state} ${session.needsAttention ? "needs-attention" : ""} ${
                  draggingSessionId === session.sessionId ? "is-dragging" : ""
                } ${dropTargetId === session.sessionId ? "is-drop-target" : ""}`}
                onClick={() => void activateSession(session)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void activateSession(session);
                  }
                }}
                onDragOver={(event) => {
                  if (!draggingSessionId || draggingSessionId === session.sessionId) {
                    return;
                  }

                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(session.sessionId);
                }}
                onDragLeave={() => {
                  if (dropTargetId === session.sessionId) {
                    setDropTargetId(null);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  moveSessionBefore(session);
                  setDraggingSessionId(null);
                  setDropTargetId(null);
                }}
              >
                <span
                  className="row-drag-handle"
                  title="Drag card"
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", session.sessionId);
                    setDraggingSessionId(session.sessionId);
                    setDropTargetId(null);
                    setFeedback(`Dragging ${session.title}.`);
                  }}
                  onDragEnd={() => {
                    setDraggingSessionId(null);
                    setDropTargetId(null);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <GripVertical size={15} aria-hidden="true" />
                </span>
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
                <span className="row-action" aria-hidden="true">
                  {activatingId === session.sessionId ? "..." : <ExternalLink size={15} />}
                </span>
              </div>
            ))}
          </section>

          <footer className="feedback-line" title={feedback}>
            {feedback}
          </footer>
        </>
      )}
    </main>
  );
}
