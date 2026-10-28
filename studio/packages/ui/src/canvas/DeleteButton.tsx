import type { ReactNode } from "react";

/**
 * The canvas sidebar's 删除 and 拿掉 buttons (2026-10-29, the user: coloured like 归档): the face of the buttons beside
 * them with the glyph in deep red, red-tinted under the pointer (`soft-danger`, the same tokens as 归档任务). `off`: the
 * card only leaves the canvas (a box with a minus), not a bin, so it does not read as deleting the task.
 */
export function DeleteButton({ children, icon = "trash", title, onClick, testId }: { children: ReactNode; icon?: "trash" | "off"; title?: string; onClick(): void; testId?: string }) {
  return (
    <button type="button" className="btn-ghost small with-icon soft-danger canvas-delete" title={title} onClick={onClick} data-testid={testId}>
      {icon === "trash" ? <TrashIcon /> : <OffIcon />}
      {children}
    </button>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4.3h11M6.2 4.3V2.7h3.6v1.6M3.9 4.3l.7 8.9a.9.9 0 0 0 .9.8h5a.9.9 0 0 0 .9-.8l.7-8.9M6.6 6.9v4.5M9.4 6.9v4.5" />
    </svg>
  );
}

function OffIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.3" y="2.8" width="11.4" height="10.4" rx="1.6" />
      <path d="M5.4 8h5.2" />
    </svg>
  );
}
