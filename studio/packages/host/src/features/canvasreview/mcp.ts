import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

const STATUS = z.enum(["todo", "confirmed", "discuss", "parked", "done"]);

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). 画布审阅: talking, not structure, so none waits for the person. */
export function canvasReviewTools({ service, caller, ownTopic }: ToolContext): AmoTool[] {
  return [
    {
      name: "canvas_items_post",
      title: "画布铺审阅条目",
      description:
        "When the person asks for a review on the canvas: lay it out on your topic's canvas as numbered item cards (#1, #2… continuing the canvas's numbers), each point a card the person can confirm, question or talk over on its own. group: an existing group (id or exact title) to add to, or the title of a new group (recommended: one group per review); omit to put them below everything. Each item: title (one line), body (Markdown: what you found, why it matters, what you suggest), refs (files, commits, links), status (todo by default; confirmed, discuss, parked, done). Studio lays them out. Then use canvas_callout to highlight or ask on the items.",
      inputSchema: {
        group: z.string().optional(),
        items: z.array(z.object({ title: z.string(), body: z.string().optional(), refs: z.array(z.string()).optional(), status: STATUS.optional() })),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.canvasReview.postItems(c.sessionId, ownTopic(c), args)),
    },
    {
      name: "canvas_item_update",
      title: "改审阅条目",
      description:
        "Change a review item on your topic's canvas (item: #n or its id): status (todo 待看, confirmed 已确认, discuss 要讨论, parked 搁置, done 完成), title, body, refs, or conclusion (what was decided; shows on the card). Use it when the person answered, or when talking an item over reached a result.",
      inputSchema: { item: z.string(), status: STATUS.optional(), title: z.string().optional(), body: z.string().optional(), conclusion: z.string().optional(), refs: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.canvasReview.updateItem(ownTopic(c), args.item, args)),
    },
    {
      name: "canvas_callout",
      title: "画布说明/提问",
      description:
        "Pin a bubble to a card on your topic's canvas. target: #n for a review item, a task id (its card), or a note's, reference card's or group's id from canvas_read. kind note (default): a remark that highlights the card (what to look at, a risk). kind question: waits for the person; give options when there are a few answers to pick from, detail (Markdown) for background, deep: true when it is too involved for a short answer (the person is pointed to this conversation). The person's answer comes back to you as a message starting 【画布回答】; after dealing with it, close the bubble with canvas_callout_close. Keep text short (one or two sentences).",
      inputSchema: {
        target: z.string(),
        kind: z.enum(["note", "question"]).optional(),
        text: z.string(),
        detail: z.string().optional(),
        options: z.array(z.string()).optional(),
        deep: z.boolean().optional(),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.canvasReview.addCallout(c.sessionId, ownTopic(c), args)),
    },
    {
      name: "canvas_callout_close",
      title: "收起画布气泡",
      description: "Put a bubble on your topic's canvas away once it is dealt with: calloutId (from canvas_callout or canvas_read), or target to close every bubble on that card.",
      inputSchema: { calloutId: z.string().optional(), target: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.canvasReview.closeFor(ownTopic(c), args)),
    },
  ];
}
