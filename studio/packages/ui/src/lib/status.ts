import type { Session, SessionStatus, Task, TaskColumn } from "@amo-studio/protocol";

// Status words and colours follow design/prototype/Main.dc.html (ST table); "出错" is new for failed turns.

export const COLUMN_NAMES: Record<TaskColumn, string> = { todo: "待办", doing: "进行中", review: "待审阅", done: "完成" };

export interface StatusLook {
  label: string;
  dot: string;
  text: string;
}

export const SESSION_LOOK: Record<SessionStatus, StatusLook> = {
  running: { label: "运行中", dot: "var(--running)", text: "var(--running-text)" },
  "awaiting-approval": { label: "待批准", dot: "var(--attention)", text: "var(--attention)" },
  "awaiting-answer": { label: "等你回答", dot: "var(--attention)", text: "var(--attention)" },
  "awaiting-review": { label: "待审阅", dot: "var(--attention)", text: "var(--attention)" },
  error: { label: "出错", dot: "var(--error)", text: "var(--error-text)" },
  idle: { label: "空闲", dot: "var(--muted-dot)", text: "var(--text-dim)" },
  completed: { label: "已完成", dot: "var(--muted-dot)", text: "var(--text-dim)" },
  // A subagent stopped before it finished (2026-10-27: it looked like an idle one).
  interrupted: { label: "被中断", dot: "var(--error)", text: "var(--error-text)" },
};

/** Most urgent first: a card shows the status that most needs the person. */
const PRIORITY: SessionStatus[] = ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "running", "idle", "interrupted", "completed"];

/** A task's status is derived from its live (non-archived) sessions; the column is separate and set by the person. */
export function taskStatus(sessions: readonly Session[]): SessionStatus | null {
  const live = sessions.filter((s) => !s.archivedAt);
  if (!live.length) return null;
  return PRIORITY.find((p) => live.some((s) => s.status === p)) ?? "idle";
}

export const needsPerson = (status: SessionStatus | null) => status === "awaiting-approval" || status === "awaiting-answer" || status === "awaiting-review";

export function taskSessions(task: Task, sessions: readonly Session[]): Session[] {
  return sessions.filter((s) => s.taskId === task.id);
}

/** "刚刚", "5 分钟前", "3 小时前", "2 天前", then the date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
