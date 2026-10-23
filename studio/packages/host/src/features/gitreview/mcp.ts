import { z } from "zod";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";

/** Opens the human's review UI; the caller identity, never a model-supplied id, receives its comments. */
export function gitReviewTools({ service, caller }: ToolContext): AmoTool[] {
  return [{
    name: "review_open",
    title: "打开文件审阅",
    description: "Open AMO's reviewer for the person. To show several files (or files with highlighted lines, or proposed changes) use view_open instead. mode=file shows the current file (even unchanged/non-git), with optional 1-based line/endLine; mode=changes (default) shows Git changes, optionally selecting file. base compares the working tree with a ref; commit or range A..B/A...B shows read-only committed changes. Reopening reads the latest saved content. Defaults to your session's project; workspaceId selects another registered project. The person copies their comments and pastes them where the work goes on (often back to you); nothing comes back by itself. Opening the UI does not mean the person has reviewed or approved the work.",
    inputSchema: {
      workspaceId: z.string().optional(),
      mode: z.enum(["file", "changes"]).optional(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      base: z.string().optional(),
      commit: z.string().optional(),
      range: z.string().optional(),
    },
    readOnly: false,
    autoApprove: true,
    run: (args) => writeAsync(caller, async (c) => {
      const session = service.store.getSession(c.sessionId);
      if (!session) throw new HostError("not_found", "AMO session not found");
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : session.workspaceId;
      if (!workspaceId) throw new HostError("bad_request", "This session has no project; supply workspaceId from project_context or board_list");
      // One file to look at goes into a 查看包 (2026-10-23), so quick calls about two files share one window.
      const file = typeof args.file === "string" && args.file ? args.file : null;
      if (file && (args.mode === "file" || args.mode === undefined || args.mode === "changes")) {
        const fileMode = args.mode === "file";
        const item = fileMode
          ? { kind: "file", path: file, ...(args.line !== undefined ? { line: args.line } : {}), ...(args.endLine !== undefined ? { endLine: args.endLine } : {}) }
          : { kind: "git", files: [file], ...(args.range ? { range: args.range } : args.commit ? { commit: args.commit, ...(args.base ? { base: args.base } : {}) } : args.base ? { base: args.base } : {}) };
        const { pack, merged } = await service.viewPacks.open({ workspaceId, items: [item] }, { sessionId: c.sessionId });
        return { packId: pack.id, title: pack.title, merged, note: "已在 Studio 里打开给人看；这不代表人已经看过或认可。" };
      }
      return service.gitReview.openReview({ ...args, workspaceId, sessionId: c.sessionId });
    }),
  }];
}
