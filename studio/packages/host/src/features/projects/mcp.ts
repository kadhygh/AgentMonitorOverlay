import { z } from "zod";
import { isCommon, type Id, type ProjectGroup, type Workspace } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, write, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import type { HostService } from "../../service.js";

// 2026-11-18 (the user: 现在需要给amo 增加ai可以 添加工程和删除工程的/处理工程分组的接口了): agents register projects,
// take them out of Studio and arrange 项目分组 — the person's own setup, so each call waits for their approval
// (mcp/names.ts PROMPTED_WRITE_TOOLS), and the approval card says what it changes (approvalNote).

/** A live project (not the common space) by id, name or folder path. */
function projectRef(service: HostService, ref: unknown): Workspace {
  const ws = service.sessions.workspaceByRef(ref);
  if (isCommon(ws)) throw new HostError("bad_request", "公共空间不是项目，不能放进分组或移除");
  return ws;
}

const refs = (service: HostService, list: unknown): Id[] | undefined => (Array.isArray(list) ? list.map((r) => projectRef(service, r).id) : undefined);

/** A group as agents read it: its projects by name, archived ones left out (as the left column does). */
export function shownGroup(service: HostService, g: ProjectGroup) {
  const projects = g.workspaceIds.flatMap((id) => {
    const w = service.store.getWorkspace(id);
    return w && !w.archivedAt ? [{ id: w.id, name: w.name }] : [];
  });
  return { id: g.id, name: g.name, ...(g.description ? { description: g.description } : {}), projects };
}

const quoted = (names: readonly string[]) => names.map((n) => `「${n}」`).join("、");

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function projectsTools({ service, caller, model }: ToolContext): AmoTool[] {
  const groupOf = (id: Id) => service.config.projectGroups().find((g) => g.workspaceIds.includes(id));
  const liveNames = (ids: readonly Id[]) =>
    ids.flatMap((id) => {
      const w = service.store.getWorkspace(id);
      return w && !w.archivedAt ? [w.name] : [];
    });
  return [
    {
      name: "project_context",
      title: "项目信息",
      description:
        "Registered projects (name, path, the person's note on it, open tasks), the project groups (项目分组, in the left column's order) and the common folder where work without a project runs. With a project (id or name), that project, its group and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.projectContext(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "project_add",
      title: "添加项目",
      description:
        "Only when the person asks: register a folder as a project in Studio. path: an existing folder on this computer; name (default: the folder's name) and description (the person's note on the project) optional; group: an existing project group (id or name) to put it in. A folder already registered is not added again: you get that project back unchanged. The person approves first.",
      inputSchema: { path: z.string(), name: z.string().optional(), description: z.string().optional(), group: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      approvalNote: (args) => {
        const name = typeof args.name === "string" && args.name.trim() ? `「${args.name.trim()}」` : "";
        const group = typeof args.group === "string" && args.group.trim() ? `，放进项目分组「${args.group.trim()}」` : "";
        return `把文件夹 ${String(args.path ?? "")} 登记为 Studio 的项目${name}${group}。已经登记过的不重复登记，也不改动它。`;
      },
      run: (args) =>
        write(caller, () => {
          // The group first: a wrong one refuses the call before anything is registered.
          const group = typeof args.group === "string" && args.group.trim() ? service.config.projectGroup(args.group) : null;
          const { workspace, added } = service.projects.ensureWorkspace({
            path: String(args.path ?? ""),
            ...(typeof args.name === "string" ? { name: args.name } : {}),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
          });
          const project = { id: workspace.id, name: workspace.name, path: workspace.path, ...(workspace.description ? { description: workspace.description } : {}) };
          if (!added) {
            const current = groupOf(workspace.id);
            return { project, alreadyRegistered: true, group: current?.name ?? null, note: "这个文件夹已经是 Studio 的项目，没有改动（名称、说明、分组都没动；改分组用 project_group_save）。" };
          }
          const placed = group ? service.config.saveProjectGroup({ id: group.id, add: [workspace.id] }) : null;
          return { project, added: true, group: placed?.name ?? null };
        }),
    },
    {
      name: "project_remove",
      title: "移除项目",
      description:
        "Only when the person asks: take a project (id, name or path) out of Studio — only out of Studio: the folder and its files are not touched. As the person's 归档项目: it leaves every list and its tasks are archived with their sessions; the person can restore it in 设置 → 数据管理. Refused while a session of it is still at work (yours included). The person approves first, told how many tasks go with it.",
      inputSchema: { workspace: z.string() },
      readOnly: false,
      autoApprove: false,
      approvalNote: (args) => {
        const { workspace, tasks, moving } = service.projects.archiveFacts(projectRef(service, args.workspace).id);
        const group = groupOf(workspace.id);
        const listed = tasks.length ? `（${quoted(tasks.slice(0, 5).map((t) => t.title || "未命名任务"))}${tasks.length > 5 ? " 等" : ""}）` : "";
        return [
          `从 Studio 里移除项目「${workspace.name}」（${workspace.path}）：只取消登记，文件夹和里面的文件不动。`,
          `它的 ${tasks.length} 个任务${listed}和这些任务的会话一起归档，可以在 设置 → 数据管理 里恢复。`,
          ...(group ? [`它在项目分组「${group.name}」里，恢复后还在。`] : []),
          ...(moving.length ? [`其中 ${moving.length} 个会话还在运行或等人，Studio 会拒绝这次移除。`] : []),
        ].join("");
      },
      run: (args) =>
        writeAsync(caller, async () => {
          const { workspace, tasks } = await service.projects.archiveForAgent(projectRef(service, args.workspace).id);
          return { removed: { id: workspace.id, name: workspace.name, path: workspace.path }, archivedTasks: tasks.length, note: "已从 Studio 移除（归档），文件夹没动；人可以在 设置 → 数据管理 里恢复或彻底删除。" };
        }),
    },
    {
      name: "project_group_save",
      title: "设项目分组",
      description:
        "Only when the person asks: add a project group (项目分组, the groups of the left column; no id, name required) or change one (id: its id or name). name and description (the person's note on the group); projects: the group's projects in order (ids, names or paths), replacing its list; add: projects to put in at the end (a project is in one group only, so it leaves its old one); remove: projects to take out (they become ungrouped); position: where the group goes among the groups (0 = first). The person approves first.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        projects: z.array(z.string()).optional(),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
        position: z.number().int().optional(),
      },
      readOnly: false,
      autoApprove: false,
      approvalNote: (args) => {
        const existing = typeof args.id === "string" && args.id.trim() ? service.config.projectGroup(args.id) : null;
        const names = (list: unknown) => liveNames(refs(service, list) ?? []);
        const parts = [existing ? `改项目分组「${existing.name}」` : `新建项目分组「${String(args.name ?? "").trim()}」`];
        if (existing && typeof args.name === "string" && args.name.trim() !== existing.name) parts.push(`改名为「${args.name.trim()}」`);
        if (typeof args.description === "string") parts.push(args.description.trim() ? "改说明" : "清空说明");
        if (Array.isArray(args.projects)) parts.push(`里面的项目改成 ${quoted(names(args.projects)) || "（空）"}`);
        if (Array.isArray(args.add) && args.add.length) {
          const moved = (refs(service, args.add) ?? []).flatMap((id) => {
            const from = groupOf(id);
            return from && from.id !== existing?.id ? [`「${service.store.getWorkspace(id)!.name}」从「${from.name}」移过来`] : [];
          });
          parts.push(`放入 ${quoted(names(args.add))}${moved.length ? `（${moved.join("，")}）` : ""}`);
        }
        if (Array.isArray(args.remove) && args.remove.length) parts.push(`移出 ${quoted(names(args.remove))}（回到未分组）`);
        if (typeof args.position === "number") parts.push(`排到第 ${args.position + 1} 个`);
        return `${parts.join("；")}。项目本身不动。`;
      },
      run: (args) =>
        write(caller, () => {
          const existing = typeof args.id === "string" && args.id.trim() ? service.config.projectGroup(args.id) : null;
          const projects = refs(service, args.projects);
          const add = refs(service, args.add);
          const remove = refs(service, args.remove);
          const saved = service.config.saveProjectGroup({
            ...(existing ? { id: existing.id } : {}),
            ...(typeof args.name === "string" ? { name: args.name } : {}),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
            ...(projects ? { projects } : {}),
            ...(add ? { add } : {}),
            ...(remove ? { remove } : {}),
            ...(typeof args.position === "number" ? { position: args.position } : {}),
          });
          return { group: shownGroup(service, saved), groups: service.config.projectGroups().map((g) => g.name) };
        }),
    },
    {
      name: "project_group_delete",
      title: "删项目分组",
      description: "Only when the person asks: remove a project group (id or name). Its projects become ungrouped; the projects themselves are not touched. The person approves first, told which projects are in it.",
      inputSchema: { id: z.string() },
      readOnly: false,
      autoApprove: false,
      approvalNote: (args) => {
        const g = service.config.projectGroup(String(args.id ?? ""));
        const names = liveNames(g.workspaceIds);
        return `删除项目分组「${g.name}」：${names.length ? `里面的 ${names.length} 个项目 ${quoted(names)} 回到未分组` : "里面没有项目"}；项目本身不动。`;
      },
      run: (args) =>
        write(caller, () => {
          const g = service.config.deleteProjectGroup(service.config.projectGroup(String(args.id)).id);
          return { removed: { id: g.id, name: g.name }, ungrouped: liveNames(g.workspaceIds) };
        }),
    },
  ];
}
