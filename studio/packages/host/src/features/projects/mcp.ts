import { z } from "zod";
import { answer, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function projectsTools({ model }: ToolContext): AmoTool[] {
  return [
    {
      name: "project_context",
      title: "项目信息",
      description: "Registered projects (name, path, open tasks) and the common folder where work without a project runs. With a project (id or name), that project and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.projectContext(args.workspace === undefined ? undefined : String(args.workspace))),
    },
  ];
}
