import { z } from "zod";
import { MAX_VIEW_ITEMS, VIEW_KINDS, viewItemLabel } from "@amo-studio/protocol";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** view_open: an agent shows the person files and changes in one window (查看包). */
export function viewPacksTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "view_open",
      title: "给人看",
      description:
        "Show the person files and changes together in one window (a 查看包): a list of items beside a preview. Put everything they should look at into one call — not one call per file. " +
        "kind=file: a file as it is now (path); highlights mark lines for them, each {line, endLine?, note} — point at what matters and say why. " +
        "kind=git: changes — source working (uncommitted, the default), base (the working tree against a ref), commit, or range (A..B, or A...B from where B forked). files: the ones to point at — listed first, above the rest of the changes, which stay visible. highlights: lines of changed files for them, each {path, line, endLine?, note} (line numbers of the new version). " +
        "kind=proposal: a change you suggest but have not made — path and the whole proposed content; shown as a diff against the file, nothing on disk changes. " +
        "Paths are relative to the project (default: your session's). Comments the person writes come back to your conversation. Opening it does not mean they have read or approved anything.",
      inputSchema: {
        title: z.string().optional(),
        workspaceId: z.string().optional(),
        items: z
          .array(
            z.object({
              kind: z.enum(VIEW_KINDS),
              title: z.string().optional(),
              note: z.string().optional(),
              path: z.string().optional(),
              highlights: z.array(z.object({ path: z.string().optional(), line: z.number().int().positive(), endLine: z.number().int().positive().optional(), note: z.string().optional() })).optional(),
              line: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
              source: z.enum(["working", "base", "commit", "range"]).optional(),
              base: z.string().optional(),
              commit: z.string().optional(),
              range: z.string().optional(),
              files: z.array(z.string()).optional(),
              proposed: z.string().optional(),
            }),
          )
          .min(1)
          .max(MAX_VIEW_ITEMS),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        writeAsync(caller, async (c) => {
          const { pack, merged } = await service.viewPacks.open(args, { sessionId: c.sessionId });
          return {
            packId: pack.id,
            title: pack.title,
            items: pack.items.map((i) => ({ kind: i.kind, label: viewItemLabel(i) })),
            merged,
            note: merged ? "已加进你刚才打开的查看包（同一个窗口）。" : "已在 Studio 里打开给人看；这不代表人已经看过或认可。",
          };
        }),
    },
  ];
}
