import type { Id } from "./entities.js";

// 提示词模板 (2026-10-31): prompts the person keeps to start the same kind of work again. Picked from the composer's @
// list (AMO 扩展功能 → 提示词模板…), the text goes into the composer for the person to send; agents add them through
// AMO's MCP when the person asks. Kept in Studio's data folder, never in a project. Plain text for now (no variables).

export interface PromptTemplate {
  id: Id;
  title: string;
  body: string;
  /** Only in this project's composers; null: everywhere. */
  workspaceId: Id | null;
  /** Who wrote it last: the person in Studio, or an agent through MCP (shown as「AI 写的」). */
  by: "person" | "agent";
  createdAt: string;
  updatedAt: string;
}

export interface NewPromptTemplate {
  title: string;
  body: string;
  workspaceId?: Id | null;
}

export type PromptTemplatePatch = Partial<NewPromptTemplate>;

export const PROMPT_TEMPLATE_LIMITS = { count: 200, title: 80, body: 20000 } as const;
