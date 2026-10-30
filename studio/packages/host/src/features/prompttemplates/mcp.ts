import { z } from "zod";
import { isCommon, type Id, type PromptTemplate } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import type { HostService } from "../../service.js";

/** A project named by id or name; "all" (or "") for every project. */
function projectRef(service: HostService, ref: string): Id | null {
  const wanted = ref.trim();
  if (!wanted || wanted === "all") return null;
  const ws = service.store.listWorkspaces().find((w) => !isCommon(w) && !w.archivedAt && (w.id === wanted || w.name === wanted));
  if (!ws) throw new HostError("not_found", `没有叫 ${wanted} 的项目`);
  return ws.id;
}

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function promptTemplatesTools({ service, caller }: ToolContext): AmoTool[] {
  const names = () => new Map(service.store.listWorkspaces().map((w) => [w.id, w.name]));
  const shown = (t: PromptTemplate, project = names()) => ({
    id: t.id,
    title: t.title,
    body: t.body,
    project: t.workspaceId ? (project.get(t.workspaceId) ?? t.workspaceId) : "全局",
    by: t.by === "agent" ? "AI" : "人",
    updatedAt: t.updatedAt,
  });
  return [
    {
      name: "prompt_template_list",
      title: "提示词模板",
      description:
        "The person's prompt templates (提示词模板): texts they keep to start the same kind of work again, picked from the composer's @ list and pasted into it. All of them, or with `workspace` (a project's id or name) those offered there: the global ones and that project's.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) =>
        answer(() => {
          const project = names();
          const ws = args.workspace === undefined ? null : projectRef(service, String(args.workspace));
          return service.promptTemplates.list(ws ?? undefined).map((t) => shown(t, project));
        }),
    },
    {
      // Saving goes without asking (the user, 2026-10-31: 新增修改直接生效; the template window marks them AI 写的).
      name: "prompt_template_save",
      title: "存提示词模板",
      description:
        "Only when the person asks: add a prompt template (no id; title and body required) or change one (id; title, body and/or workspace). workspace: a project (id or name) to offer it only there, \"all\" for every project; a new one without it is global. Plain text: no variables are filled in. The person sees it marked as written by AI.",
      inputSchema: { id: z.string().optional(), title: z.string().optional(), body: z.string().optional(), workspace: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, () => {
          const ws = args.workspace === undefined ? undefined : projectRef(service, String(args.workspace));
          if (args.id === undefined) return shown(service.promptTemplates.create({ title: args.title as string, body: args.body as string, workspaceId: ws ?? null }, "agent"));
          return shown(
            service.promptTemplates.update(
              String(args.id),
              { ...(args.title !== undefined ? { title: args.title as string } : {}), ...(args.body !== undefined ? { body: args.body as string } : {}), ...(ws !== undefined ? { workspaceId: ws } : {}) },
              "agent",
            ),
          );
        }),
    },
    {
      // Removing waits for the person's approval (not autoApprove).
      name: "prompt_template_delete",
      title: "删提示词模板",
      description: "Only when the person asks: remove a prompt template (id from prompt_template_list). The person approves first.",
      inputSchema: { id: z.string() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, () => ({ removed: shown(service.promptTemplates.remove(String(args.id))) })),
    },
  ];
}
