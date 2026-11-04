import { useEffect, useRef, type ReactNode } from "react";
import { Modal } from "./Modal.js";

/**
 * A question before something big (归档项目, 彻底删除): a title, what will happen, 取消 (focused, so Enter does not
 * confirm by accident) and the action. Escape cancels only this dialog, not one underneath.
 */
export function ConfirmDialog({
  title,
  children,
  action,
  danger,
  busy,
  onCancel,
  onConfirm,
  testId,
}: {
  title: string;
  children: ReactNode;
  action: string;
  danger?: boolean;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
  testId?: string;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <Modal portal role="alertdialog" backdropClassName="confirm-backdrop" className="confirm-modal" labelledBy="confirm-title" testId={testId ?? "confirm-dialog"} busy={busy} onClose={onCancel}>
      <span className="modal-title" id="confirm-title">
        {title}
      </span>
      {children}
      <div className="settings-row end">
        <button ref={cancel} type="button" className="btn-ghost small" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className={danger ? "btn-danger small" : "btn-primary small"} onClick={onConfirm} disabled={busy} data-testid="confirm-action">
          {action}
        </button>
      </div>
    </Modal>
  );
}
