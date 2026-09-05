import { useEffect, useMemo, useRef, useState } from "react";
import { CheckSquare, Flag, ListTodo, Search, Square, X } from "lucide-react";
import {
  BROKER_SESSION_EVENTS_URL,
  BROKER_SESSION_PRIORITIES_URL,
  postBrokerJson,
} from "../api/brokerClient";
import { toolDisplayForSession } from "../components/SessionCard";
import {
  SESSION_PRIORITIES,
  normalizeSessions,
  mergeChangedSession,
  normalizeSessionPriority,
  sessionPriorityLabels,
} from "../domain/sessionModel";
import { projectName } from "../domain/routingModel";
import type { AgentSession, SessionPriority } from "../types";
import type { SessionPriorityUpdateResult } from "../hooks/useSessionPriorities";
import { SessionRuntimeController } from "../runtime/sessionRuntimeController";
import { SessionRevisionGate, createSingleFlight } from "../runtime/sessionRevisionGate";
import { useSessionReplica } from "../hooks/useSessionReplica";
import { loadActiveSessionSnapshot } from "../api/sessionSnapshot";
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
  const { sessions, setSessions, replica } = useSessionReplica();
  const gate = useRef(new SessionRevisionGate()).current;
  const refreshFlight = useRef(createSingleFlight<void>()).current;
  const controllerRef = useRef<SessionRuntimeController | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("Loading active cards...");

  async function loadSessions() {
    return refreshFlight.run(async () => {
      const requestGeneration = gate.requestGeneration();
      try {
        const payload = await loadActiveSessionSnapshot(AbortSignal.timeout(2500));
        if (!replica.acceptsSnapshot(payload.brokerInstanceId, payload.storeRevision) ||
          !gate.acceptSnapshot(payload.revision, payload.brokerInstanceId, requestGeneration).accepted) {
          controllerRef.current?.scheduleReconcile("priority-stale-snapshot");
          return;
        }
        replica.beginInstance(payload.brokerInstanceId);
        const nextSessions = normalizeSessions(payload) || [];
        replica.markMissingActive(nextSessions, payload.storeRevision);
        setSessions(nextSessions.filter((session) => !session.archivedAt));
        const activeIds = new Set(nextSessions.filter((session) => !session.archivedAt).map((session) => session.sessionId));
        setSelectedIds((current) => new Set([...current].filter((sessionId) => activeIds.has(sessionId))));
        setFeedback(`${activeIds.size} active cards`);
      } catch (error) {
        setFeedback(`Could not load cards: ${(error as Error).message}`);
      }
    });
  }

  useEffect(() => {
    void loadSessions();
    let runtimeController: SessionRuntimeController;
    runtimeController = new SessionRuntimeController({
      eventUrl: BROKER_SESSION_EVENTS_URL,
      refresh: loadSessions,
      onBrokerReady: (event) => {
        const payload = JSON.parse(event.data);
        if (!gate.observeInstance(payload.brokerInstanceId).accepted) return;
        replica.beginInstance(payload.brokerInstanceId);
        runtimeController.scheduleReconcile("priority-broker-ready");
      },
      onSessionsChanged: (event) => {
        try {
          const payload = JSON.parse(event.data);
          const revision = gate.observeEvent(payload.sequence, payload.brokerInstanceId);
          if (!revision.accepted) return;
          if (payload.session) setSessions((current) => mergeChangedSession(current, payload.session));
          if (payload.removedSessions) {
            setSessions((current) => (payload.removedSessions as AgentSession[]).reduce(mergeChangedSession, current));
          }
          if (revision.gap || (!payload.session && !payload.removedSessions)) {
            runtimeController.scheduleReconcile("priority-session-event");
          }
        } catch {
          runtimeController.scheduleReconcile("priority-event-invalid");
        }
      },
    });
    runtimeController.start();
    controllerRef.current = runtimeController;
    return () => {
      runtimeController.stop();
      controllerRef.current = null;
    };
  }, []);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => {
      if (session.archivedAt) return false;
      const priority = normalizeSessionPriority(session.priority);
      const matchesPriority =
        priorityFilter === "all" ||
        (priorityFilter === "none" ? priority === null : priority === priorityFilter);
      return matchesPriority && sessionMatchesSearch(session, search);
    }),
    [priorityFilter, search, sessions],
  );

  useEffect(() => {
    const activeIds = new Set(sessions.filter((session) => !session.archivedAt).map((session) => session.sessionId));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((sessionId) => activeIds.has(sessionId)));
      return next.size === current.size ? current : next;
    });
  }, [sessions]);

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
