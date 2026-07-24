import { useEffect } from "react";
import { Check, Flag, ListTodo, X } from "lucide-react";
import {
  SESSION_PRIORITIES,
  normalizeSessionPriority,
  sessionPriorityLabels,
} from "../domain/sessionModel";
import type { AgentSession, SessionPriority } from "../types";

export interface PriorityMenuState {
  session: AgentSession;
  x: number;
  y: number;
}

interface PriorityMenuProps {
  state: PriorityMenuState;
  busy: boolean;
  onClose: () => void;
  onManage: () => void;
  onSelect: (priority: SessionPriority | null) => void;
}

export function PriorityMenu({ state, busy, onClose, onManage, onSelect }: PriorityMenuProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const currentPriority = normalizeSessionPriority(state.session.priority);
  const left = Math.max(6, Math.min(state.x, window.innerWidth - 224));
  const top = Math.max(6, Math.min(state.y, window.innerHeight - 226));

  return (
    <div className="priority-menu-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="priority-menu"
        role="menu"
        aria-label={`Priority for ${state.session.taskTitle || state.session.title}`}
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Flag size={13} aria-hidden="true" />
          <span>Priority</span>
        </header>
        <div className="priority-menu-options">
          {SESSION_PRIORITIES.map((priority) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={currentPriority === priority}
              className={`priority-menu-item priority-${priority}`}
              disabled={busy}
              key={priority}
              onClick={() => onSelect(priority)}
            >
              <span className="priority-menu-swatch" aria-hidden="true" />
              <span>{sessionPriorityLabels[priority]}</span>
              {currentPriority === priority ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={currentPriority === null}
            className="priority-menu-item priority-none"
            disabled={busy}
            onClick={() => onSelect(null)}
          >
            <X size={12} aria-hidden="true" />
            <span>None</span>
            {currentPriority === null ? <Check size={13} aria-hidden="true" /> : null}
          </button>
        </div>
        <button type="button" className="priority-menu-manage" disabled={busy} onClick={onManage}>
          <ListTodo size={13} aria-hidden="true" />
          <span>Manage priorities</span>
        </button>
      </section>
    </div>
  );
}
