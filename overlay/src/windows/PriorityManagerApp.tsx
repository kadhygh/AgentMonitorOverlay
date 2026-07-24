import { useEffect, useMemo, useState } from "react";
import { CheckSquare, Flag, ListTodo, Search, Square, X } from "lucide-react";
import {
  BROKER_SESSIONS_URL,
  BROKER_SESSION_PRIORITIES_URL,
  getBrokerJson,
  postBrokerJson,
} from "../api/brokerClient";
import { toolDisplayForSession } from "../components/SessionCard";
import {
  SESSION_PRIORITIES,
  normalizeSessions,
  normalizeSessionPriority,
  sessionPriorityLabels,
} from "../domain/sessionModel";
import { projectName } from "../domain/routingModel";
import type { AgentSession, SessionPriority } from "../types";
import type { SessionPriorityUpdateResult } from "../hooks/useSessionPriorities";
import {
  closeUtilityWindow,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
} from "./utilityWindow";
import { useAmoThemeRuntime } from "../theme/amoTheme";

type PriorityFilter = "all" | "none" | SessionPriority;

function sessionMatchesSearch(session: AgentSession, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    session.taskTitle,
    session.title,
    session.sessionId,
    session.cwd,
    session.workspacePath,
    session.tool,
    projectName(session.cwd || session.workspacePath || ""),
    toolDisplayForSession(session).label,
  ].filter(Boolean).join("\n").toLowerCase().includes(query);
}

function mergeUpdatedSessions(current: AgentSession[], updated: AgentSession[]) {
  const updates = new Map(updated.map((session) => [session.sessionId, session]));
  return current.map((session) => updates.get(session.sessionId) || session);
}

export function PriorityManagerApp() {
  useAmoThemeRuntime();
  useUtilityWindowLifecycle("priorities");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("Loading active cards...");

  async function loadSessions() {
    try {
      const payload = await getBrokerJson<unknown>(BROKER_SESSIONS_URL);
      const nextSessions = normalizeSessions(payload) || [];
      setSessions(nextSessions.filter((session) => !session.archivedAt));
      setSelectedIds((current) => new Set([...current].filter((sessionId) =>
        nextSessions.some((session) => session.sessionId === sessionId && !session.archivedAt)
      )));
      setFeedback(`${nextSessions.filter((session) => !session.archivedAt).length} active cards`);
    } catch (error) {
      setFeedback(`Could not load cards: ${(error as Error).message}`);
    }
  }

  useEffect(() => {
    void loadSessions();
    const intervalId = window.setInterval(() => void loadSessions(), 3000);
    const refreshOnFocus = () => void loadSessions();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, []);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => {
      const priority = normalizeSessionPriority(session.priority);
      const matchesPriority =
        priorityFilter === "all" ||
        (priorityFilter === "none" ? priority === null : priority === priorityFilter);
      return matchesPriority && sessionMatchesSearch(session, search);
    }),
    [priorityFilter, search, sessions],
  );

  const visibleIds = visibleSessions.map((session) => session.sessionId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((sessionId) => selectedIds.has(sessionId));

  function toggleSession(sessionId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((sessionId) => next.delete(sessionId));
      else visibleIds.forEach((sessionId) => next.add(sessionId));
      return next;
    });
  }

  async function applyPriority(priority: SessionPriority | null) {
    const sessionIds = [...selectedIds];
    if (sessionIds.length === 0 || busy) return;
    setBusy(true);
    setFeedback(priority ? `Setting ${sessionPriorityLabels[priority]}...` : "Clearing priorities...");
    try {
      const result = await postBrokerJson<SessionPriorityUpdateResult>(BROKER_SESSION_PRIORITIES_URL, {
        sessionIds,
        priority,
      });
      setSessions((current) => mergeUpdatedSessions(current, result.sessions));
      setFeedback(
        priority
          ? `Set ${result.count} card${result.count === 1 ? "" : "s"} to ${sessionPriorityLabels[priority]}.`
          : `Cleared ${result.count} priorit${result.count === 1 ? "y" : "ies"}.`,
      );
    } catch (error) {
      setFeedback(`Priority update failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="utility-window-shell priority-window-shell">
      <section className="app-dialog priority-manager" role="dialog" aria-label="Task priority manager">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <ListTodo size={16} aria-hidden="true" />
            <div>
              <strong>Task Priorities</strong>
              <span>Classify first, keep manual order inside each group</span>
            </div>
          </div>
          <button
            type="button"
            className="candidate-close"
            title="Close priorities"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void closeUtilityWindow("priorities")}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <div className="priority-manager-toolbar">
          <div className="priority-filter-group" aria-label="Priority filters">
            {(["all", ...SESSION_PRIORITIES, "none"] as PriorityFilter[]).map((priority) => (
              <button
                type="button"
                key={priority}
                className={`priority-filter priority-${priority} ${priorityFilter === priority ? "is-active" : ""}`}
                aria-pressed={priorityFilter === priority}
                onClick={() => setPriorityFilter(priority)}
              >
                {priority === "all" ? "All" : priority === "none" ? "None" : sessionPriorityLabels[priority]}
              </button>
            ))}
          </div>
          <label className="priority-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={search}
              placeholder="Search cards"
              aria-label="Search active cards"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
        </div>

        <div className="priority-selection-bar">
          <button type="button" className="priority-select-all" onClick={toggleAllVisible}>
            {allVisibleSelected ? <CheckSquare size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
            <span>{allVisibleSelected ? "Clear visible" : "Select visible"}</span>
          </button>
          <span>{selectedIds.size} selected</span>
          <div className="priority-batch-actions" aria-label="Set selected priority">
            {SESSION_PRIORITIES.map((priority) => (
              <button
                type="button"
                key={priority}
                className={`priority-action priority-${priority}`}
                disabled={busy || selectedIds.size === 0}
                onClick={() => void applyPriority(priority)}
              >
                <Flag size={12} aria-hidden="true" />
                <span>{sessionPriorityLabels[priority]}</span>
              </button>
            ))}
            <button
              type="button"
              className="priority-action priority-none"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void applyPriority(null)}
            >
              <X size={12} aria-hidden="true" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div className="priority-card-list" role="list" aria-label="Active task cards">
          {visibleSessions.length > 0 ? visibleSessions.map((session) => {
            const priority = normalizeSessionPriority(session.priority);
            const checked = selectedIds.has(session.sessionId);
            return (
              <label
                className={`priority-card-row ${checked ? "is-selected" : ""}`}
                key={session.sessionId}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleSession(session.sessionId)} />
                <span className="priority-card-copy">
                  <strong>{session.taskTitle?.trim() || session.title || session.sessionId}</strong>
                  <small>
                    {projectName(session.cwd || session.workspacePath || "")} � {toolDisplayForSession(session).label}
                  </small>
                </span>
                <span className={`priority-card-value priority-${priority || "none"}`}>
                  {priority ? sessionPriorityLabels[priority] : "None"}
                </span>
              </label>
            );
          }) : (
            <div className="priority-empty-state">No active cards match this view.</div>
          )}
        </div>

        <footer className="app-dialog-footer priority-manager-footer">
          <span aria-live="polite">{feedback}</span>
          <span>{visibleSessions.length} shown � {sessions.length} active</span>
        </footer>
      </section>
    </main>
  );
}
