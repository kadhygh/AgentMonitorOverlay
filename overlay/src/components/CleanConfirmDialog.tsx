import { X } from "lucide-react";
import { projectName } from "../domain/routingModel";
import type { AgentSession } from "../types";

export interface CleanConfirmState {
  session: AgentSession;
  workspacePath: string;
  replyNotes: number;
  promptNotes: number;
  canvasNodes: number;
}

interface CleanConfirmDialogProps {
  state: CleanConfirmState;
  onClose: () => void;
  onConfirm: () => void;
}

export function CleanConfirmDialog({ state, onClose, onConfirm }: CleanConfirmDialogProps) {
  return (
    <div className="confirm-backdrop" role="presentation" onClick={onClose}>
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm AMO vault cleanup"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <strong>Clean AMO Vault?</strong>
          <button type="button" className="candidate-close" title="Cancel" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <p>
          This will clear generated notes and reset the canvas for <strong>{projectName(state.workspacePath)}</strong>.
        </p>
        <div className="confirm-counts">
          <span>
            <strong>{state.replyNotes}</strong>
            replies
          </span>
          <span>
            <strong>{state.promptNotes}</strong>
            prompts
          </span>
          <span>
            <strong>{state.canvasNodes}</strong>
            nodes
          </span>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            Confirm Clean
          </button>
        </div>
      </section>
    </div>
  );
}
