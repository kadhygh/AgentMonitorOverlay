import { useEffect } from "react";

// Archived tasks and sessions (stage 14): the date they were archived, their icon, and the box after 归档任务.

/** "3 月 5 日 14:20" (this year) or "2025 年 3 月 5 日". */
export function formatDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${time}` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function ArchiveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="archive-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="2.5" width="12.4" height="3.2" rx="0.8" />
      <path d="M2.8 5.7v7a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-7M6.3 8.3h3.4" />
    </svg>
  );
}

/**
 * After 归档任务 (stage 14): what was archived, and the way back to where the task was opened from (看板 or 画布), or
 * 关闭 to stay on the now read-only page.
 */
export function TaskArchivedDialog({ title, sessions, backLabel, onBack, onClose }: { title: string; sessions: number; backLabel: string; onBack(): void; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop archived-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal archived-dialog" role="dialog" aria-modal="true" aria-labelledby="archived-dialog-title" data-testid="task-archived-dialog">
        <div className="archived-dialog-head">
          <ArchiveIcon size={20} />
          <span className="modal-title" id="archived-dialog-title">
            任务已归档
          </span>
        </div>
        <p className="archived-dialog-body">
          已归档任务「<b>{title}</b>」{sessions > 0 ? `和它的 ${sessions} 个会话` : ""}。它不再出现在看板和画布上，可以在看板最后一列底部的「已归档」里找到并恢复。
        </p>
        <div className="archived-dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose} data-testid="archived-dialog-close">
            关闭
          </button>
          <button type="button" className="btn-primary" onClick={onBack} autoFocus data-testid="archived-dialog-back">
            返回{backLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
