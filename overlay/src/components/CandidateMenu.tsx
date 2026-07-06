import { CircleCheck, SquareTerminal, X } from "lucide-react";
import {
  activationCandidateKey,
  codexAppThreadUri,
  projectName,
  workspacePathForSession,
} from "../domain/routingModel";
import type { ActivationCandidate, AgentSession } from "../types";

export interface CandidateMenuState {
  session: AgentSession;
  candidates: ActivationCandidate[];
  x: number;
  y: number;
  bindOnSelect: boolean;
  clearAttentionOnConfirm: boolean;
  selectedCandidateKey: string | null;
  codexAppAvailable: boolean;
  codexCliResumeAvailable: boolean;
}

interface CandidateMenuProps {
  state: CandidateMenuState;
  activating: boolean;
  onClose: () => void;
  onBindOnSelectChange: (checked: boolean) => void;
  onSelectCandidate: (candidateKey: string) => void;
  onOpenCodexAppTarget: () => void;
  onOpenCodexCliTarget: () => void;
  onFocusCandidate: (candidate: ActivationCandidate) => void;
  onConfirmCandidate: (candidate: ActivationCandidate) => void;
}

function activationCandidateMeta(candidate: ActivationCandidate) {
  const process = candidate.processName ?? "unknown";
  return `${process} · PID ${candidate.processId} · HWND ${candidate.hwnd}`;
}

function candidateMenuContextLabel(session: AgentSession) {
  const conversationName = (session.taskTitle || session.title || session.sessionId || "Session").trim();
  const project = projectName(workspacePathForSession(session) || session.cwd || "") || "Project";
  return `${conversationName} - ${project}`;
}

export function CandidateMenu({
  state,
  activating,
  onClose,
  onBindOnSelectChange,
  onSelectCandidate,
  onOpenCodexAppTarget,
  onOpenCodexCliTarget,
  onFocusCandidate,
  onConfirmCandidate,
}: CandidateMenuProps) {
  const selectedCandidate =
    state.candidates.find((candidate) => activationCandidateKey(candidate) === state.selectedCandidateKey) ?? null;
  const contextLabel = candidateMenuContextLabel(state.session);

  return (
    <div
      className="candidate-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="candidate-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Target candidates"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="candidate-menu-header">
          <div>
            <strong>Choose Target</strong>
            <span title={contextLabel}>
              {contextLabel} · {state.candidates.length} window(s)
            </span>
          </div>
          <button type="button" className="candidate-close" title="Close" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>

        <label className="candidate-bind-toggle">
          <input
            type="checkbox"
            checked={state.bindOnSelect}
            onChange={(event) => onBindOnSelectChange(event.currentTarget.checked)}
          />
          <span>Remember target after Confirm</span>
        </label>

        <div className="candidate-list">
          {state.codexAppAvailable ? (
            <button
              type="button"
              className="candidate-item codex-app-candidate"
              title={codexAppThreadUri(state.session.sessionId)}
              onClick={onOpenCodexAppTarget}
            >
              <strong>Codex App</strong>
              <span>Open thread {state.session.sessionId}</span>
            </button>
          ) : null}
          {state.candidates.map((candidate) => {
            const candidateKey = activationCandidateKey(candidate);
            return (
              <button
                type="button"
                className={`candidate-item ${candidateKey === state.selectedCandidateKey ? "is-selected" : ""}`}
                key={`${candidate.hwnd}-${candidate.processId}`}
                title={candidate.label}
                aria-pressed={candidateKey === state.selectedCandidateKey}
                onClick={() => onSelectCandidate(candidateKey)}
              >
                <strong>{candidate.processName ?? "Window"}</strong>
                <span>{candidate.title}</span>
                <small>{activationCandidateMeta(candidate)}</small>
              </button>
            );
          })}
        </div>

        <div className={`candidate-actions ${state.codexCliResumeAvailable ? "has-launch-action" : ""}`}>
          {state.codexCliResumeAvailable ? (
            <button
              type="button"
              className="candidate-launch-action"
              title={`Start a new terminal: codex resume ${state.session.sessionId}`}
              disabled={activating}
              onClick={onOpenCodexCliTarget}
            >
              <SquareTerminal size={13} aria-hidden="true" />
              <span>New CLI</span>
            </button>
          ) : null}
          <button
            type="button"
            className="candidate-secondary-action"
            disabled={!selectedCandidate || activating}
            onClick={() => {
              if (selectedCandidate) {
                onFocusCandidate(selectedCandidate);
              }
            }}
          >
            Focus
          </button>
          <button
            type="button"
            className="candidate-confirm-action"
            disabled={!selectedCandidate || activating}
            onClick={() => {
              if (selectedCandidate) {
                onConfirmCandidate(selectedCandidate);
              }
            }}
          >
            <CircleCheck size={13} aria-hidden="true" />
            <span>Confirm</span>
          </button>
        </div>
      </section>
    </div>
  );
}
