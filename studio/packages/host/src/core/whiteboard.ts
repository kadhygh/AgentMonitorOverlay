import type { WhiteboardNode, WhiteboardNote, Id } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 白板 (2026-11-16, protocol/src/whiteboard.ts, plans/whiteboard.md): what Studio keeps of a session's board. One kv row per session
// for the data (`whiteboard:<sessionId>`) and one for the page its AI gave (`whiteboard-view:<sessionId>`, apart so a change of a
// node does not rewrite a long page). Here rather than in features/whiteboard so the sessions feature can read what to tell
// the AI with the person's next message without depending on that feature.

export interface WhiteboardState {
  on: boolean;
  /** The seq of the session's last row when its AI was last told about the board (0: not yet). */
  toldAt: number;
  rev: number;
  seenRev: number;
  nodes: WhiteboardNode[];
  notes: WhiteboardNote[];
}

const key = (sessionId: Id) => `whiteboard:${sessionId}`;
const viewKey = (sessionId: Id) => `whiteboard-view:${sessionId}`;

export function readWhiteboard(store: Store, sessionId: Id): WhiteboardState {
  const empty: WhiteboardState = { on: false, toldAt: 0, rev: 0, seenRev: 0, nodes: [], notes: [] };
  const raw = store.getKv(key(sessionId))?.value;
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<WhiteboardState>;
    return { on: v.on === true, toldAt: Number(v.toldAt) || 0, rev: Number(v.rev) || 0, seenRev: Number(v.seenRev) || 0, nodes: Array.isArray(v.nodes) ? v.nodes : [], notes: Array.isArray(v.notes) ? v.notes : [] };
  } catch {
    return empty;
  }
}

export function writeWhiteboard(store: Store, sessionId: Id, state: WhiteboardState): void {
  store.setKv(key(sessionId), JSON.stringify(state));
}

/** The page the session's AI gave for its board, if it gave one. */
export function readWhiteboardView(store: Store, sessionId: Id): { html: string; at: string } | null {
  const raw = store.getKv(viewKey(sessionId))?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { html?: unknown; at?: unknown };
    return typeof v.html === "string" && v.html ? { html: v.html, at: typeof v.at === "string" ? v.at : "" } : null;
  } catch {
    return null;
  }
}

/** `html` empty: back to Studio's own page. */
export function writeWhiteboardView(store: Store, sessionId: Id, html: string): void {
  store.setKv(viewKey(sessionId), html ? JSON.stringify({ html, at: new Date().toISOString() }) : "");
}

/** Where a note is, in words for the AI. */
export function noteWhere(note: WhiteboardNote, nodes: readonly WhiteboardNode[]): string {
  const node = note.nodeId ? nodes.find((n) => n.id === note.nodeId) : undefined;
  const quote = note.quote ? `（那里的字：「${note.quote}」）` : "";
  if (note.gone) return `在已经拿掉的节点「${note.gone}」上`;
  if (node) return note.x === undefined ? `在节点 ${node.id}「${node.title}」上` : `在节点 ${node.id}「${node.title}」旁边${quote}`;
  return `在白板的一个位置上${quote}`;
}

/**
 * What the AI of a session with a board is told with the person's next message: what the board is — once after it was
 * turned on, and after each compaction (it has forgotten; the board is where it reads what was settled) — and the notes
 * the person pinned since (批注 gather until the person writes: one message for all, not one interruption each).
 * `told()` once the message went in. Empty when there is nothing to say.
 */
export function whiteboardHint(store: Store, sessionId: Id): { lines: string[]; told(): void } {
  const state = readWhiteboard(store, sessionId);
  if (!state.on) return { lines: [], told: () => undefined };
  const [compaction] = store.findItems(sessionId, "compaction", {}, { newest: true, limit: 1 });
  const first = state.toldAt === 0;
  const forgot = !first && !!compaction && compaction.seq >= state.toldAt;
  const drafts = state.notes.filter((n) => n.state === "draft");
  const lines: string[] = [];
  if (first)
    lines.push(
      "这个会话开了「白板」：一块你写、人看的工作白板（人不改它，只在上面写批注）。把确认下来的任务内容、推进计划的每一步、你给的每条建议、子会话查到的结论、定下来的事各写成一个节点（whiteboard_update），之后有进展就改节点的状态和内容，不要只在回复里说；回复里不用重复白板上已有的内容，提节点的标题就行。人的批注会随消息带给你，用 whiteboard_update 的 replies 逐条回应。想换个摆法、加一张图，用 whiteboard_view 改画它的页面。你要是没有 whiteboard_update 这个工具，就告诉人：这个会话是在「白板」打开之前启动的，要等它下次启动才用得上。",
    );
  if (forgot) lines.push("上下文压缩过了。这个会话有「白板」：先调 whiteboard_read，任务内容、计划、定下来的事和人还没处理完的批注都在上面；之后照旧用 whiteboard_update 记。");
  if (drafts.length) {
    lines.push(`人在白板上新写了 ${drafts.length} 条批注（用 whiteboard_update 的 replies 逐条回应，该改节点的改节点）：`);
    for (const n of drafts) lines.push(`· ${n.id}，${noteWhere(n, state.nodes)}：${n.text}`);
  }
  return {
    lines,
    told: () => {
      if (!lines.length) return;
      const now = readWhiteboard(store, sessionId);
      const sent = new Set(drafts.map((n) => n.id));
      const last = store.listLastItems(sessionId, 1)[0];
      writeWhiteboard(store, sessionId, { ...now, toldAt: first || forgot ? (last?.seq ?? 1) : now.toldAt, notes: now.notes.map((n) => (sent.has(n.id) && n.state === "draft" ? { ...n, state: "sent" } : n)) });
    },
  };
}
