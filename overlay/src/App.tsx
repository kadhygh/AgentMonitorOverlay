import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ChevronDown, ChevronUp, ExternalLink, GripHorizontal, Minimize2, RefreshCcw } from "lucide-react";
import { mockSessions } from "./mockSessions";
import type { ActivationResult, AgentSession, SessionState } from "./types";

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

export default function App() {
  const [sessions, setSessions] = useState<AgentSession[]>(mockSessions);
  const [collapsed, setCollapsed] = useState(false);
  const [source, setSource] = useState<"mock" | "broker">("mock");
  const [feedback, setFeedback] = useState("Mock data ready. Window activation is placeholder.");
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

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

      setSessions(nextSessions.slice(0, 8));
      setSource("broker");
      setLastRefreshAt(new Date().toISOString());
      setFeedback(`Broker sessions loaded: ${nextSessions.length}`);
    } catch (error) {
      setSessions(mockSessions);
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
        hwnd: session.windowHint?.hwnd ?? null,
      });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Activation command failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
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
            {sessions.slice(0, 8).map((session) => (
              <button
                type="button"
                key={session.sessionId}
                className={`session-row state-${session.state} ${session.needsAttention ? "needs-attention" : ""}`}
                onClick={() => void activateSession(session)}
              >
                <span className="state-dot" aria-label={stateLabel[session.state]} />
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
              </button>
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
