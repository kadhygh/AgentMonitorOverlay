import { z } from "zod";
import { WHITEBOARD_KINDS, WHITEBOARD_STATUSES, experimentalEnabled } from "@amo-studio/protocol";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { WHITEBOARD_VIEW_CONTRACT } from "./template.js";

const KINDS = Object.entries(WHITEBOARD_KINDS).map(([id, label]) => `${id} ${label}`).join(", ");
const STATUSES = Object.entries(WHITEBOARD_STATUSES).map(([id, label]) => `${id} ${label}`).join(", ");

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). None while 白板 (设置 → 测试功能) is off. */
export function whiteboardTools({ service, caller }: ToolContext): AmoTool[] {
  if (!experimentalEnabled(service.config.experimentalFeatures(), "whiteboard")) return [];
  const node = z.object({
    id: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.string().optional(),
    group: z.string().optional(),
    after: z.array(z.string()).optional(),
    from: z.string().optional(),
  });
  return [
    {
      name: "whiteboard_read",
      title: "白板：读",
      description:
        "Your session's 白板 (working board; you are told when the session has one): every node (what the task is, the plan, your suggestions, what sub-sessions found, what was settled) and the person's notes on it that are not closed. Read it after a context compaction, and whenever you are not sure what was agreed — it is where that is kept, outside your context.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => write(caller, (c) => service.whiteboard.read(c.sessionId)),
    },
    {
      name: "whiteboard_update",
      title: "白板：写",
      description: `Write your session's 白板: the person follows the work there instead of scrolling the conversation, and only you write it. set: nodes to add or change — with an id the board has, only the fields you give change; without one (or with a new short id of your own, so other nodes can name it in after) a node is added. Fields: kind (${KINDS}), title (one line), body (a few lines of Markdown), status (${STATUSES}), group (the column it is in, a short name of yours such as 任务内容, 推进计划, 调查结果), after (ids of the nodes it follows, drawn as lines), from (who gave it, e.g. a sub-session's name). remove: ids of nodes to take off. replies: your answer to a note the person pinned, { note: its id, text } — answer each note you are told of, and change the nodes it asks for in the same call. Keep nodes short and current: change a node when things move rather than adding another, and one call for a batch of changes.`,
      inputSchema: { set: z.array(node).optional(), remove: z.array(z.string()).optional(), replies: z.array(z.object({ note: z.string(), text: z.string() })).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.whiteboard.update(c.sessionId, args)),
    },
    {
      name: "whiteboard_view",
      title: "白板：画它的页面",
      description: `The HTML page that draws your session's 白板, when Studio's own (columns of cards by group) does not show the work well — another layout, a diagram, a table. Without arguments: the present page, to change it. html: a whole new page; edits: [{ old, new }] to change places of the present one (each old found exactly once) — the quick way to adjust it; reset: true to go back to Studio's own. ${WHITEBOARD_VIEW_CONTRACT}`,
      inputSchema: { html: z.string().optional(), edits: z.array(z.object({ old: z.string(), new: z.string() })).optional(), reset: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.whiteboard.view(c.sessionId, args)),
    },
  ];
}
