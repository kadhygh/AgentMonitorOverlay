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

// ---- Host routes (declared here, part of api.ts's HostRoutes) --------------------------------------------------

/** 提示词模板 (2026-10-31). */
export interface PromptTemplateRoutes {
  /** Every template, or (`?workspace=<id>`) those a composer in that project offers: the global ones and the project's (`global`: only the global ones). */
  "GET /api/prompt-templates": { req: void; res: PromptTemplate[] };
  "POST /api/prompt-templates": { req: NewPromptTemplate; res: PromptTemplate };
  "PATCH /api/prompt-templates/:id": { req: PromptTemplatePatch; res: PromptTemplate };
  "DELETE /api/prompt-templates/:id": { req: void; res: { ok: true } };
}
