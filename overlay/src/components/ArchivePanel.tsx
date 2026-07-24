import { Archive, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toolDisplayForSession } from "./SessionCard";
import { projectName } from "../domain/routingModel";
import type { AgentSession } from "../types";

interface ArchivePanelProps {
  sessions: AgentSession[];
  dismissingSessionId: string | null;
  clearing: boolean;
  onClose: () => void;
  onDismiss: (session: AgentSession) => void;
  onClear: () => void;
}

function matchesSearch(session: AgentSession, search: string) {
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
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

export function ArchivePanel({
  sessions,
  dismissingSessionId,
  clearing,
  onClose,
  onDismiss,
  onClear,
}: ArchivePanelProps) {
  const [search, setSearch] = useState("");
  const visibleSessions = useMemo(
    () => sessions.filter((session) => matchesSearch(session, search)),
    [search, sessions],
  );

  return (
    <div className="archive-panel-backdrop" role="presentation" onClick={onClose}>
      <section
        className="archive-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Archived task cards"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="archive-panel-header">
          <div>
            <Archive size={15} aria-hidden="true" />
            <span>
              <strong>Archive</strong>
              <small>{sessions.length} archived cards</small>
            </span>
          </div>
          <button type="button" className="candidate-close" title="Close archive" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <label className="archive-panel-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="Search archive"
            aria-label="Search archived cards"
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>

        <div className="archive-panel-list" role="list">
          {visibleSessions.length > 0 ? visibleSessions.map((session) => {
            const dismissing = dismissingSessionId === session.sessionId;
            return (
              <div className="archive-panel-row" role="listitem" key={session.sessionId}>
                <span>
                  <strong>{session.taskTitle?.trim() || session.title || session.sessionId}</strong>
                  <small>
                    {projectName(session.cwd || session.workspacePath || "")} | {toolDisplayForSession(session).label}
                  </small>
                </span>
                <button
                  type="button"
                  title="Permanently hide card"
                  aria-label={'Permanently hide ' + (session.taskTitle?.trim() || session.title || session.sessionId)}
                  disabled={dismissing || clearing}
                  onClick={() => onDismiss(session)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            );
          }) : (
            <div className="archive-panel-empty">
              {sessions.length > 0 ? "No archived cards match this search." : "Archive is empty."}
            </div>
          )}
        </div>

        <footer className="archive-panel-footer">
          <span>{visibleSessions.length} shown</span>
          <button type="button" disabled={sessions.length === 0 || clearing} onClick={onClear}>
            <Trash2 size={12} aria-hidden="true" />
            <span>{clearing ? "Clearing..." : "Clear archive"}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}