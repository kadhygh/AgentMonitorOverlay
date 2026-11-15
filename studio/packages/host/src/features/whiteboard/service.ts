import { WHITEBOARD_BODY_MAX, WHITEBOARD_GROUP_MAX, WHITEBOARD_KINDS, WHITEBOARD_NODES_MAX, WHITEBOARD_NOTES_MAX, WHITEBOARD_NOTE_MAX, WHITEBOARD_QUOTE_MAX, WHITEBOARD_STATUSES, WHITEBOARD_TITLE_MAX, WHITEBOARD_VIEW_MAX, type WhiteboardData, type WhiteboardKind, type WhiteboardNode, type WhiteboardNote, type WhiteboardStatus, type Id } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { noteWhere, readWhiteboard, readWhiteboardView, writeWhiteboard, writeWhiteboardView, type WhiteboardState } from "../../core/whiteboard.js";
import { DEFAULT_WHITEBOARD_VIEW } from "./template.js";

/** The sessions with a board, so the workbench knows which to ask for without asking for each. */
const ON_KEY = "whiteboard.on"; // a dot, not whiteboard:… — that prefix is the per-session key (core/whiteboard.ts), dropped with its session

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const line = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
/** Several lines: kept as written, without the space around them. */
const prose = (value: unknown): string => (typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "");
const NODE_ID = /^[A-Za-z0-9_-]{1,24}$/;
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);

/** What the session's AI reads (whiteboard_read) and gets back from a write: the data without what is empty. */
export interface WhiteboardForAi {
  rev: number;
  nodes: Array<Partial<WhiteboardNode> & { id: string; title: string }>;
  /** The person's notes not closed yet. */
  notes: Array<{ id: string; where: string; text: string; state: WhiteboardNote["state"]; reply?: string }>;
  /** Whose page draws it. */
  view: "yours" | "studio";
}

/**
 * 白板 (2026-11-16, protocol/src/whiteboard.ts, plans/whiteboard.md; the user: 人和白板更像是一个中间数据层…人看白板来快速了解，ai 直接看
 * 数据结构一次就能看清。未来遇到 ai 上下文压缩，也能通过看这些加深记忆): a session's working board. Its AI writes the nodes
 * (whiteboard_update) and may give the page that draws them (whiteboard_view); the person looks, and pins notes that go to the AI
 * with their next message (core/whiteboard.ts, whiteboardHint).
 */
export class WhiteboardFeature extends Feature {
  get(sessionId: Id): WhiteboardData {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    const own = readWhiteboardView(this.store, sessionId);
    return { sessionId, on: state.on, rev: state.rev, seenRev: state.seenRev, nodes: state.nodes, notes: state.notes, view: own ? { html: own.html, own: true, at: own.at, fallback: DEFAULT_WHITEBOARD_VIEW } : { html: DEFAULT_WHITEBOARD_VIEW, own: false } };
  }

  listOn(): Id[] {
    try {
      const ids = JSON.parse(this.store.getKv(ON_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(ids) ? ids.filter((id): id is Id => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  private save(sessionId: Id, state: WhiteboardState): void {
    writeWhiteboard(this.store, sessionId, state);
    this.changed(sessionId);
  }

  /** Said to the workbench (the sessions feature says the same once the person's notes went to the AI). */
  private changed(sessionId: Id): void {
    const state = readWhiteboard(this.store, sessionId);
    this.publish({ type: "whiteboard.changed", sessionId, on: state.on, rev: state.rev, seenRev: state.seenRev });
  }

  /** How far a board is and how far the person has looked: the mark on 「白板」 above the conversation. */
  mark(sessionId: Id): { sessionId: Id; rev: number; seenRev: number } {
    const state = readWhiteboard(this.store, sessionId);
    return { sessionId, rev: state.rev, seenRev: state.seenRev };
  }

  /** The person's side: the board on or off (its AI is told with their next message), and 「看过了」 up to this rev. */
  set(sessionId: Id, input: { on?: unknown; seen?: unknown }): WhiteboardData {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    let next = state;
    if (input.on !== undefined) {
      if (typeof input.on !== "boolean") throw new HostError("bad_request", "on must be true or false");
      if (state.on !== input.on) {
        next = { ...next, on: input.on, toldAt: 0 };
        const list = this.listOn();
        this.store.setKv(ON_KEY, JSON.stringify(input.on ? [...list.filter((id) => id !== sessionId), sessionId] : list.filter((id) => id !== sessionId)));
      }
    }
    if (input.seen === true && next.seenRev !== next.rev) next = { ...next, seenRev: next.rev };
    if (next !== state) this.save(sessionId, next);
    return this.get(sessionId);
  }

  // ---- the person's notes (批注)

  /** A note on a node (nodeId), beside one (nodeId, x, y: from its corner) or at a place of the page (x, y). */
  addNote(sessionId: Id, input: { nodeId?: unknown; x?: unknown; y?: unknown; quote?: unknown; text?: unknown }): WhiteboardData {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    const text = cut(prose(input.text), WHITEBOARD_NOTE_MAX);
    if (!text) throw new HostError("bad_request", "批注是空的");
    const nodeId = typeof input.nodeId === "string" && input.nodeId ? input.nodeId : undefined;
    if (nodeId && !state.nodes.some((n) => n.id === nodeId)) throw new HostError("not_found", "白板上已经没有这个节点了");
    const x = num(input.x);
    const y = num(input.y);
    if (!nodeId && (x === undefined || y === undefined)) throw new HostError("bad_request", "批注要落在一个节点上，或者白板上的一个位置");
    const seq = state.notes.reduce((max, n) => Math.max(max, Number(n.id.slice(1)) || 0), 0) + 1;
    const quote = cut(line(input.quote), WHITEBOARD_QUOTE_MAX);
    const note: WhiteboardNote = { id: `c${seq}`, ...(nodeId ? { nodeId } : {}), ...(x !== undefined && y !== undefined ? { x, y } : {}), ...(quote ? { quote } : {}), text, at: new Date().toISOString(), state: "draft" };
    let notes = [...state.notes, note];
    // Past the limit the oldest closed ones go.
    while (notes.length > WHITEBOARD_NOTES_MAX) {
      const drop = notes.find((n) => n.state === "closed");
      if (!drop) throw new HostError("bad_request", `白板上的批注太多了（${WHITEBOARD_NOTES_MAX} 条）：先把处理完的关掉`);
      notes = notes.filter((n) => n !== drop);
    }
    this.save(sessionId, { ...state, notes });
    return this.get(sessionId);
  }

  /** The person rewrites a note not sent yet, closes one they are done with, or opens it again. */
  editNote(sessionId: Id, noteId: string, input: { text?: unknown; closed?: unknown }): WhiteboardData {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) throw new HostError("not_found", "没有这条批注");
    let next: WhiteboardNote = note;
    if (input.text !== undefined) {
      if (note.state !== "draft") throw new HostError("bad_request", "这条批注已经发给 AI 了，不能再改：要补充就再写一条");
      const text = cut(prose(input.text), WHITEBOARD_NOTE_MAX);
      if (!text) throw new HostError("bad_request", "批注是空的");
      next = { ...next, text };
    }
    if (input.closed === true) next = { ...next, state: "closed" };
    // Opened again: back to where it stood — answered, or still with the AI.
    if (input.closed === false && note.state === "closed") next = { ...next, state: note.reply ? "answered" : "sent" };
    if (next !== note) this.save(sessionId, { ...state, notes: state.notes.map((n) => (n === note ? next : n)) });
    return this.get(sessionId);
  }

  removeNote(sessionId: Id, noteId: string): WhiteboardData {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    if (state.notes.some((n) => n.id === noteId)) this.save(sessionId, { ...state, notes: state.notes.filter((n) => n.id !== noteId) });
    return this.get(sessionId);
  }

  // ---- the AI's side (features/whiteboard/mcp.ts)

  read(sessionId: Id): WhiteboardForAi {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    return {
      rev: state.rev,
      nodes: state.nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, ...(n.body ? { body: n.body } : {}), status: n.status, ...(n.group ? { group: n.group } : {}), ...(n.after.length ? { after: n.after } : {}), ...(n.from ? { from: n.from } : {}) })),
      notes: state.notes.filter((n) => n.state !== "closed").map((n) => ({ id: n.id, where: noteWhere(n, state.nodes), text: n.text, state: n.state, ...(n.reply ? { reply: n.reply } : {}) })),
      view: readWhiteboardView(this.store, sessionId) ? "yours" : "studio",
    };
  }

  /**
   * whiteboard_update: nodes added or changed (`set`: with an id the board has, the given fields change; else a new node,
   * under the id given or the next n…), nodes taken off (`remove`), and replies to the person's notes (`replies`).
   */
  update(sessionId: Id, input: { set?: unknown; remove?: unknown; replies?: unknown }): { rev: number; added: Array<{ id: string; title: string }>; changed: string[]; removed: string[]; replied: string[]; open: WhiteboardForAi["notes"] } {
    this.requireSession(sessionId);
    const state = readWhiteboard(this.store, sessionId);
    const set = Array.isArray(input.set) ? (input.set as Array<Record<string, unknown>>) : [];
    const remove = new Set((Array.isArray(input.remove) ? input.remove : []).map(String));
    const replies = Array.isArray(input.replies) ? (input.replies as Array<Record<string, unknown>>) : [];
    if (!set.length && !remove.size && !replies.length) throw new HostError("bad_request", "给 set（加或改的节点）、remove（拿掉的节点 id）或 replies（对批注的回应）中的至少一样");
    const rev = state.rev + 1;
    const at = new Date().toISOString();
    let nodes = state.nodes.filter((n) => !remove.has(n.id));
    const removed = state.nodes.filter((n) => remove.has(n.id)).map((n) => n.id);
    let seq = state.nodes.reduce((max, n) => Math.max(max, /^n\d+$/.test(n.id) ? Number(n.id.slice(1)) : 0), 0);
    const added: Array<{ id: string; title: string }> = [];
    const changed: string[] = [];
    for (const raw of set) {
      if (!raw || typeof raw !== "object") throw new HostError("bad_request", "set 的每一项是一个节点：{ id?, kind?, title?, body?, status?, group?, after?, from? }");
      const given = typeof raw.id === "string" ? raw.id.trim() : "";
      if (given && !NODE_ID.test(given)) throw new HostError("bad_request", `节点 id「${cut(given, 30)}」不行：用字母、数字、- 和 _，最多 24 个字符`);
      if (given && remove.has(given)) throw new HostError("bad_request", `节点 ${given} 同时在 set 和 remove 里`);
      const kind = raw.kind === undefined ? undefined : String(raw.kind);
      if (kind !== undefined && !(kind in WHITEBOARD_KINDS)) throw new HostError("bad_request", `kind 是这几种之一：${Object.keys(WHITEBOARD_KINDS).join("、")}`);
      const status = raw.status === undefined ? undefined : String(raw.status);
      if (status !== undefined && !(status in WHITEBOARD_STATUSES)) throw new HostError("bad_request", `status 是这几种之一：${Object.keys(WHITEBOARD_STATUSES).join("、")}`);
      const fields: Partial<WhiteboardNode> = {
        ...(kind !== undefined ? { kind: kind as WhiteboardKind } : {}),
        ...(raw.title !== undefined ? { title: cut(line(raw.title), WHITEBOARD_TITLE_MAX) } : {}),
        ...(raw.body !== undefined ? { body: cut(prose(raw.body), WHITEBOARD_BODY_MAX) } : {}),
        ...(status !== undefined ? { status: status as WhiteboardStatus } : {}),
        ...(raw.group !== undefined ? { group: cut(line(raw.group), WHITEBOARD_GROUP_MAX) } : {}),
        ...(raw.after !== undefined ? { after: (Array.isArray(raw.after) ? raw.after : [raw.after]).map(String).filter(Boolean) } : {}),
        ...(raw.from !== undefined ? { from: cut(line(raw.from), WHITEBOARD_GROUP_MAX) } : {}),
      };
      const old = given ? nodes.find((n) => n.id === given) : undefined;
      if (old) {
        if (fields.title === "") throw new HostError("bad_request", `节点 ${old.id} 的 title 不能是空的`);
        nodes = nodes.map((n) => (n === old ? { ...old, ...fields, rev, at } : n));
        changed.push(old.id);
        continue;
      }
      if (!fields.title) throw new HostError("bad_request", "新节点要有 title");
      const id = given || `n${++seq}`;
      nodes.push({ id, kind: "note", body: "", status: "open", group: "", after: [], from: "", ...fields, title: fields.title, rev, at });
      added.push({ id, title: fields.title });
    }
    if (nodes.length > WHITEBOARD_NODES_MAX) throw new HostError("bad_request", `白板上最多 ${WHITEBOARD_NODES_MAX} 个节点：把做完的合并成一个，或者拿掉不再有用的`);
    // A line to a node that is not there (taken off, or a wrong id) is dropped rather than refused: the rest still counts.
    const ids = new Set(nodes.map((n) => n.id));
    nodes = nodes.map((n) => (n.after.every((a) => ids.has(a) && a !== n.id) ? n : { ...n, after: n.after.filter((a) => ids.has(a) && a !== n.id) }));
    const replied: string[] = [];
    let notes = state.notes;
    for (const raw of replies) {
      const id = raw && typeof raw === "object" ? String(raw.note ?? "") : "";
      const text = raw && typeof raw === "object" ? cut(prose(raw.text), WHITEBOARD_NOTE_MAX) : "";
      const note = notes.find((n) => n.id === id);
      if (!note) throw new HostError("not_found", `没有批注 ${id || "（没给 note）"}：whiteboard_read 里有还开着的批注`);
      if (!text) throw new HostError("bad_request", `对批注 ${id} 的回应是空的`);
      // A closed one stays closed: the person is done with it.
      notes = notes.map((n) => (n === note ? { ...note, reply: text, repliedAt: at, state: note.state === "closed" ? "closed" : "answered" } : n));
      replied.push(id);
    }
    // A note on a node taken off stays, without it: what the person wrote is still theirs to read.
    notes = notes.map((n) => {
      if (!n.nodeId || ids.has(n.nodeId)) return n;
      const { nodeId, x: _x, y: _y, ...rest } = n;
      return { ...rest, gone: state.nodes.find((o) => o.id === nodeId)?.title ?? nodeId };
    });
    const touched = added.length + changed.length + removed.length > 0;
    this.save(sessionId, { ...state, rev: touched ? rev : state.rev, nodes, notes });
    return { rev: touched ? rev : state.rev, added, changed, removed, replied, open: this.read(sessionId).notes };
  }

  /**
   * whiteboard_view: the page that draws the board. Nothing given: the page as it is now (Studio's own until the AI gave
   * one), to change it. `html`: a whole new page; `edits`: places of the present page replaced, each `old` found once;
   * `reset`: back to Studio's own.
   */
  view(sessionId: Id, input: { html?: unknown; edits?: unknown; reset?: unknown }): { view: "yours" | "studio"; chars: number; html?: string } {
    this.requireSession(sessionId);
    const own = readWhiteboardView(this.store, sessionId);
    const now = own?.html ?? DEFAULT_WHITEBOARD_VIEW;
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    if (input.reset === true) {
      if (own) this.put(sessionId, "");
      return { view: "studio", chars: DEFAULT_WHITEBOARD_VIEW.length };
    }
    if (typeof input.html !== "string" && !edits.length) return { view: own ? "yours" : "studio", chars: now.length, html: now };
    let html = typeof input.html === "string" ? input.html : now;
    for (const e of edits) {
      const from = e && typeof e.old === "string" ? e.old : "";
      const to = e && typeof e.new === "string" ? e.new : null;
      if (!from || to === null) throw new HostError("bad_request", "edits 的每一项是 { old, new }：old 是现在页面里的一段原文");
      const at = html.indexOf(from);
      if (at < 0) throw new HostError("bad_request", `页面里没找到这一段：${cut(from, 80)}`);
      if (html.indexOf(from, at + 1) >= 0) throw new HostError("bad_request", `这一段在页面里不止一处，多带几个字：${cut(from, 80)}`);
      html = html.slice(0, at) + to + html.slice(at + from.length);
    }
    if (!html.trim()) throw new HostError("bad_request", "页面是空的：要回到 Studio 自带的画法用 reset");
    if (html.length > WHITEBOARD_VIEW_MAX) throw new HostError("bad_request", `页面太长了（${html.length} 个字符，最多 ${WHITEBOARD_VIEW_MAX}）：数据从 window.BOARD 读，不要写进页面里`);
    if (html !== now || !own) this.put(sessionId, html);
    return { view: "yours", chars: html.length };
  }

  private put(sessionId: Id, html: string): void {
    writeWhiteboardView(this.store, sessionId, html);
    const state = readWhiteboard(this.store, sessionId);
    this.save(sessionId, { ...state, rev: state.rev + 1 });
  }
}
