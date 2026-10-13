import { z } from "zod";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function packsTools({ model }: ToolContext): AmoTool[] {
  return [
    {
      name: "pack_list",
      title: "扩展包",
      description:
        "The project's extension packs (.amo/packs in a workspace, id or name; all workspaces when omitted): their documents (conventions, pitfalls), task templates and session presets. Read a document with pack_doc.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.packList(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "pack_doc",
      title: "扩展包文档",
      description: "One document of an extension pack (ids from pack_list), as markdown.",
      inputSchema: { workspace: z.string(), pack: z.string(), doc: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.packDoc(String(args.workspace), String(args.pack), String(args.doc))),
    },
  ];
}
