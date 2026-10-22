import { z } from "zod";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";

/** Opens the human's review UI; the caller identity, never a model-supplied id, receives its comments. */
export function gitReviewTools({ service, caller }: ToolContext): AmoTool[] {
  return [{
    name: "review_open",
    title: "打开文件审阅",
    description: "Open AMO's reviewer for the person. mode=file shows the current file (even unchanged/non-git), with optional 1-based line/endLine; mode=changes (default) shows Git changes, optionally selecting file. base compares the working tree with a ref; commit or range A..B/A...B shows read-only committed changes. Reopening reads the latest saved content. Defaults to your session's project; workspaceId selects another registered project. Comments default back to your conversation. Opening the UI does not mean the person has reviewed or approved the work.",
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
      return service.gitReview.openReview({ ...args, workspaceId, sessionId: c.sessionId });
    }),
  }];
}
