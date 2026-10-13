import { z } from "zod";
import { isCommon, lineSuffix, type FileMark } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function marksTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "list_file_marks",
      title: "文件标记",
      description:
        "Files and folders the person marked in Studio, each with their note (说明) and an optional line range. By default the marks of your session's project; `workspace` names another project (id or name), \"other\" for files outside every project, or \"all\".",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) =>
        answer(() => {
          const wanted = args.workspace === undefined ? undefined : String(args.workspace).trim();
          let filter: string | undefined;
          if (wanted === "all") filter = undefined;
          else if (wanted === "other") filter = "other";
          else if (wanted) {
            const ws = service.store.listWorkspaces().find((w) => !isCommon(w) && (w.id === wanted || w.name === wanted));
            if (!ws) throw new HostError("not_found", `没有叫 ${wanted} 的项目`);
            filter = ws.id;
          } else {
            const own = caller ? service.store.getSession(caller.sessionId)?.workspaceId : undefined;
            const ws = own ? service.store.getWorkspace(own) : undefined;
            filter = ws && !isCommon(ws) ? ws.id : undefined;
          }
          const names = new Map(service.store.listWorkspaces().map((w) => [w.id, w.name]));
          return service.marks.list(filter).map((m: FileMark) => ({
            path: m.path,
            ...(m.startLine ? { lines: lineSuffix(m.startLine, m.endLine).slice(1) } : {}),
            note: m.note,
            project: m.workspaceId ? (names.get(m.workspaceId) ?? m.workspaceId) : "其他",
            ...(m.folder ? { folder: true } : {}),
            ...(m.exists ? {} : { missing: true }),
          }));
        }),
    },
  ];
}
