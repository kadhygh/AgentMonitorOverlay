import type { Id, Timestamp } from "./entities.js";

// 设置 → 数据管理 (2026-10-14): what is archived, and deleting it for good. Only archived things can be deleted, and a
// deletion takes everything that belongs only to them (see Store.purge). Files in projects, and the CLIs' own records
// (Codex threads, Claude Code sessions in the person's home folder), are never touched.

export type DataKind = "workspace" | "topic" | "task" | "session";

export const DATA_KIND_LABEL: Record<DataKind, string> = { workspace: "项目", topic: "专题", task: "任务", session: "会话" };

/**
 * An archived thing at the top of what would go with it: a project, a topic, a task whose project and topic are
 * live, a session tree whose owner is live.
 */
export interface ArchivedEntry {
  kind: DataKind;
  id: Id;
  title: string;
  /** Where it belongs, e.g. "项目 MyGame · 专题 数值" or the task of a session. */
  context: string;
  archivedAt: Timestamp;
}

/** What deleting one entry takes with it (and, after `POST`, what it took). */
export interface PurgeSummary {
  kind: DataKind;
  id: Id;
  title: string;
  workspaces: number;
  topics: number;
  tasks: number;
  sessions: number;
  /** Conversation records (messages, tool calls, approvals…). */
  items: number;
  /** Pasted images in them (preview); after the deletion, the ones removed because nothing else used them. */
  attachments: number;
}
