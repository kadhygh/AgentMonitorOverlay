import { Trash2, X } from "lucide-react";

interface ArchiveClearConfirmDialogProps {
  count: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ArchiveClearConfirmDialog({
  count,
  busy,
  onClose,
  onConfirm,
}: ArchiveClearConfirmDialogProps) {
  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="confirm-dialog archive-clear-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm archive cleanup"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <strong>Clear Archive?</strong>
          <button type="button" className="candidate-close" title="Cancel" disabled={busy} onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <p>
          This will permanently hide <strong>{count}</strong> archived card{count === 1 ? "" : "s"} from AMO.
          Notes, canvases, workspace files, and CLI history will not be deleted.
        </p>
        <div className="confirm-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-action" disabled={busy} onClick={onConfirm}>
            <Trash2 size={13} aria-hidden="true" />
            <span>{busy ? "Clearing..." : "Clear archive"}</span>
          </button>
        </div>
      </section>
    </div>
  );
}