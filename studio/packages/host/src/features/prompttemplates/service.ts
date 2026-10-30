import { isCommon, PROMPT_TEMPLATE_LIMITS, type Id, type NewPromptTemplate, type PromptTemplate, type PromptTemplatePatch } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** All templates, as one JSON list in the Host's kv (the data folder, never a project). */
const KEY = "prompt-templates";

/**
 * 提示词模板 (2026-10-31): prompts the person keeps to start the same kind of work again, global or for one project.
 * The person writes them in the composer's template window; agents through MCP when the person asks (saving goes at
 * once, removing waits for the person's approval — the user's choice). Every change publishes `prompt-templates.changed`.
 */
export class PromptTemplatesFeature extends Feature {
  /** All templates, or those a composer in this project offers (the global ones and the project's); newest first. */
  list(workspace?: unknown): PromptTemplate[] {
    const all = this.stored();
    if (workspace === undefined || workspace === null || workspace === "") return all;
    if (typeof workspace !== "string") throw new HostError("bad_request", "workspace must be a project id");
    return all.filter((t) => t.workspaceId === null || t.workspaceId === workspace);
  }

  create(input: Partial<NewPromptTemplate> | undefined, by: PromptTemplate["by"] = "person"): PromptTemplate {
    const all = this.stored();
    if (all.length >= PROMPT_TEMPLATE_LIMITS.count) throw new HostError("conflict", `最多存 ${PROMPT_TEMPLATE_LIMITS.count} 条模板，先删掉不用的`);
    const at = new Date().toISOString();
    const template: PromptTemplate = {
      id: newId("tpl"),
      title: this.title(input?.title),
      body: this.body(input?.body),
      workspaceId: this.scope(input?.workspaceId),
      by,
      createdAt: at,
      updatedAt: at,
    };
    this.save([template, ...all], template.id);
    return template;
  }

  update(id: Id, patch: PromptTemplatePatch | undefined, by: PromptTemplate["by"] = "person"): PromptTemplate {
    const all = this.stored();
    const current = all.find((t) => t.id === id);
    if (!current) throw new HostError("not_found", `没有这条模板：${id}`);
    const p = patch ?? {};
    const next: PromptTemplate = {
      ...current,
      ...(p.title !== undefined ? { title: this.title(p.title) } : {}),
      ...(p.body !== undefined ? { body: this.body(p.body) } : {}),
      ...(p.workspaceId !== undefined ? { workspaceId: this.scope(p.workspaceId) } : {}),
      by,
      updatedAt: new Date().toISOString(),
    };
    // The edited one goes on top, as a new one does.
    this.save([next, ...all.filter((t) => t.id !== id)], id);
    return next;
  }

  remove(id: Id): PromptTemplate {
    const all = this.stored();
    const gone = all.find((t) => t.id === id);
    if (!gone) throw new HostError("not_found", `没有这条模板：${id}`);
    this.save(
      all.filter((t) => t.id !== id),
      id,
    );
    return gone;
  }

  private stored(): PromptTemplate[] {
    const raw = this.store.getKv(KEY)?.value;
    if (!raw) return [];
    try {
      const list = JSON.parse(raw) as unknown;
      return Array.isArray(list) ? (list as PromptTemplate[]) : [];
    } catch {
      return [];
    }
  }

  private save(list: PromptTemplate[], changed: Id) {
    this.store.setKv(KEY, JSON.stringify(list));
    this.publish({ type: "prompt-templates.changed", templateId: changed });
  }

  private title(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new HostError("bad_request", "模板要有标题");
    const title = value.trim().replace(/\s+/g, " ");
    if (title.length > PROMPT_TEMPLATE_LIMITS.title) throw new HostError("bad_request", `标题最长 ${PROMPT_TEMPLATE_LIMITS.title} 字`);
    return title;
  }

  private body(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new HostError("bad_request", "模板要有内容");
    if (value.length > PROMPT_TEMPLATE_LIMITS.body) throw new HostError("bad_request", `内容最长 ${PROMPT_TEMPLATE_LIMITS.body} 字`);
    return value.replace(/\s+$/, "");
  }

  /** null (or absent): global; otherwise a project (not the common space, which the person does not see as one). */
  private scope(value: unknown): Id | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new HostError("bad_request", "workspaceId must be a project id or null");
    const ws = this.requireWorkspace(value);
    return isCommon(ws) ? null : ws.id;
  }
}
