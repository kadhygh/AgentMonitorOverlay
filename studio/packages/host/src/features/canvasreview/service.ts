import { addItems, CALLOUT_DETAIL_MAX, CALLOUT_OPTIONS_MAX, CALLOUT_TEXT_MAX, findItem, isReviewStatus, REVIEW_BODY_MAX, REVIEW_STATUSES, REVIEW_TITLE_MAX, type CanvasCallout, type CanvasDoc, type CanvasItem, type CalloutKind, type Id, type NewItem, type ReviewStatus, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { boundedText, HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** At most this many items in one canvas_items_post. */
export const ITEMS_PER_POST = 40;
/** Bubbles still out on one canvas. */
export const OPEN_CALLOUTS_MAX = 100;
/** Closed bubbles the page lists (侧栏「沟通」). */
const CLOSED_LISTED = 30;

const statusLabel = (s: ReviewStatus) => REVIEW_STATUSES.find((x) => x.id === s)?.label ?? s;

/**
 * 画布审阅 (2026-10-27, plans/review-canvas.md): a review laid out on a topic's canvas as numbered items, agents'
 * remarks and questions pinned to its cards, the person's answers sent back to the asking session, and a session to
 * talk one item over (就这条展开聊).
 */
export class CanvasReviewFeature extends Feature {
  callouts(topicId: Id): CanvasCallout[] {
    this.requireTopic(topicId);
    return this.store.listCallouts(topicId, CLOSED_LISTED);
  }

  getCallout(id: Id): CanvasCallout {
    const c = this.store.getCallout(id);
    if (!c) throw new HostError("not_found", `callout ${id} not found`);
    return c;
  }

  /**
   * Lays items out on the topic's canvas. `group`: an existing group (id or exact title) to add them to, else the title
   * of a new group; absent, they go below everything ungrouped.
   */
  postItems(sessionId: Id | null, topicId: Id, input: { group?: unknown; items?: unknown }): { groupId: Id | null; items: Array<{ id: Id; num: number; title: string }> } {
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    if (!Array.isArray(input.items) || !input.items.length) throw new HostError("bad_request", "items must be a non-empty list");
    if (input.items.length > ITEMS_PER_POST) throw new HostError("bad_request", `at most ${ITEMS_PER_POST} items at once`);
    const items: NewItem[] = input.items.map((raw, i) => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const status = it.status === undefined ? "todo" : it.status;
      if (!isReviewStatus(status)) throw new HostError("bad_request", `items[${i}].status must be one of ${REVIEW_STATUSES.map((s) => s.id).join(", ")}`);
      return {
        title: boundedText(it.title, `items[${i}].title`, REVIEW_TITLE_MAX),
        status,
        ...optionalText(it.body, `items[${i}].body`, REVIEW_BODY_MAX, "body"),
        ...refsOf(it.refs, `items[${i}].refs`),
        sessionId,
      };
    });
    const groupRef = typeof input.group === "string" ? input.group.trim() : "";
    let placed: CanvasItem[] = [];
    let groupId: Id | null = null;
    this.f.canvases.mutateCanvas(topicId, (doc) => {
      const existing = groupRef ? doc.groups.find((g) => g.id === groupRef) ?? doc.groups.find((g) => g.title === groupRef) : undefined;
      if (groupRef.length > 100) throw new HostError("bad_request", "group title is too long (at most 100 characters)");
      const group = existing ? { id: existing.id } : groupRef ? { id: newId("g"), title: groupRef } : null;
      groupId = group?.id ?? null;
      const out = addItems(doc, group, items, () => newId("n"));
      placed = out.items;
      return out.doc;
    });
    return { groupId, items: placed.map((n) => ({ id: n.id, num: n.num, title: n.title })) };
  }

  /** Changes an item (by id, "#3" or "3"): its status, title, body, conclusion or refs. */
  updateItem(topicId: Id, ref: unknown, patch: Record<string, unknown>): CanvasItem {
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const key = typeof ref === "string" || typeof ref === "number" ? String(ref) : "";
    if (!key) throw new HostError("bad_request", "item is required: its id, or #n");
    if (patch.status !== undefined && !isReviewStatus(patch.status)) throw new HostError("bad_request", `status must be one of ${REVIEW_STATUSES.map((s) => s.id).join(", ")}`);
    const changes: Partial<CanvasItem> = {
      ...(patch.status !== undefined ? { status: patch.status as ReviewStatus } : {}),
      ...(patch.title !== undefined ? { title: boundedText(patch.title, "title", REVIEW_TITLE_MAX) } : {}),
      ...optionalText(patch.body, "body", REVIEW_BODY_MAX, "body"),
      ...optionalText(patch.conclusion, "conclusion", REVIEW_BODY_MAX, "conclusion"),
      ...refsOf(patch.refs, "refs"),
    };
    if (!Object.keys(changes).length) throw new HostError("bad_request", "nothing to change: give status, title, body, conclusion or refs");
    let item: CanvasItem | undefined;
    this.f.canvases.mutateCanvas(topicId, (doc) => {
      const found = findItem(doc, key);
      if (!found) throw new HostError("bad_request", `no review item ${key} on this canvas`);
      item = { ...found, ...changes };
      return { ...doc, nodes: doc.nodes.map((n) => (n.id === found.id ? item! : n)) };
    });
    return item!;
  }

  /**
   * Pins a remark or question to a card. `target`: an item ("#3" or its id), a task with a card on this canvas, or a
   * note's, reference card's or group's id.
   */
  addCallout(sessionId: Id | null, topicId: Id, input: { target?: unknown; kind?: unknown; text?: unknown; detail?: unknown; options?: unknown; deep?: unknown }): CanvasCallout {
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const kind = input.kind === undefined ? "note" : input.kind;
    if (kind !== "note" && kind !== "question") throw new HostError("bad_request", "kind must be note (说明) or question (问题)");
    const target = resolveTarget(this.f.canvases.canvas(topicId), typeof input.target === "string" ? input.target : typeof input.target === "number" ? String(input.target) : "");
    if (this.store.listCallouts(topicId).length >= OPEN_CALLOUTS_MAX) throw new HostError("bad_request", `this canvas already has ${OPEN_CALLOUTS_MAX} bubbles out; close some with canvas_callout_close first`);
    let options: string[] | undefined;
    if (input.options !== undefined && input.options !== null) {
      if (kind !== "question") throw new HostError("bad_request", "options are for a question");
      if (!Array.isArray(input.options) || input.options.length > CALLOUT_OPTIONS_MAX) throw new HostError("bad_request", `options must be a list of at most ${CALLOUT_OPTIONS_MAX}`);
      options = input.options.map((o, i) => boundedText(o, `options[${i}]`, 200));
    }
    const at = new Date().toISOString();
    const callout: CanvasCallout = {
      id: newId("co"),
      topicId,
      target,
      kind: kind as CalloutKind,
      text: boundedText(input.text, "text", CALLOUT_TEXT_MAX),
      ...optionalText(input.detail, "detail", CALLOUT_DETAIL_MAX, "detail"),
      ...(options?.length ? { options } : {}),
      ...(input.deep === true ? { deep: true } : {}),
      sessionId,
      state: "open",
      createdAt: at,
      updatedAt: at,
    };
    this.store.putCallout(callout);
    this.publish({ type: "callout.upserted", callout });
    return callout;
  }

  /**
   * The person's answer: kept on the bubble and sent to the session that wrote it as a message (a new turn, or into the
   * one running), the way the person's own messages go. A session that is gone gets nothing; the answer still shows.
   */
  async answer(id: Id, input: { text?: unknown }): Promise<CanvasCallout> {
    const current = this.getCallout(id);
    if (current.state === "closed") throw new HostError("bad_request", "this bubble is closed");
    if (this.requireTopic(current.topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const text = boundedText(input.text, "text", CALLOUT_DETAIL_MAX);
    const session = current.sessionId ? this.store.getSession(current.sessionId) : undefined;
    let sent: NonNullable<CanvasCallout["answer"]>["sent"] = "none";
    if (session && !session.archivedAt) sent = (await this.f.sessions.sendMessage(session.id, this.answerMessage(current, text))).mode;
    const next: CanvasCallout = { ...this.getCallout(id), state: "answered", answer: { text, at: new Date().toISOString(), sent }, updatedAt: new Date().toISOString() };
    this.store.putCallout(next);
    this.publish({ type: "callout.upserted", callout: next });
    return next;
  }

  /** What the asking session reads: where, what it asked, the answer, and how to finish. */
  private answerMessage(c: CanvasCallout, text: string): string {
    const topic = this.requireTopic(c.topicId);
    const on = this.targetName(c);
    return [
      `【画布回答】专题「${topic.title}」画布上 ${on} 的${c.kind === "question" ? "问题" : "说明"}：`,
      `你写的：${c.text}`,
      `人的回答：${text}`,
      "",
      `（这条消息来自画布：人在卡片上的${c.kind === "question" ? "问题框" : "说明"}里回答了你。处理完用 canvas_callout_close（calloutId: ${c.id}）收起它；是审阅条目的话，用 canvas_item_update 改这一条的状态或写结论。）`,
    ].join("\n");
  }

  private targetName(c: CanvasCallout): string {
    const doc = this.f.canvases.canvas(c.topicId);
    const n = doc.nodes.find((x) => x.id === c.target || ((x.kind === "task" || x.kind === "ref") && x.taskId === c.target));
    if (n?.kind === "item") return `#${n.num}「${n.title}」`;
    if (n?.kind === "note") return `便签「${n.text.replace(/\s+/g, " ").trim().slice(0, 40)}」`;
    if (n?.kind === "task" || n?.kind === "ref") return `任务卡片「${this.store.getTask(n.taskId)?.title || n.taskId}」`;
    const g = doc.groups.find((x) => x.id === c.target);
    return g ? `分组「${g.title}」` : "一张卡片";
  }

  /** Puts a bubble away (the person, or the agent once it has dealt with it). */
  close(id: Id): CanvasCallout {
    const current = this.getCallout(id);
    if (current.state === "closed") return current;
    const next: CanvasCallout = { ...current, state: "closed", updatedAt: new Date().toISOString() };
    this.store.putCallout(next);
    this.publish({ type: "callout.upserted", callout: next });
    return next;
  }

  /** canvas_callout_close: one bubble of the caller's topic, or every one still out on a card. */
  closeFor(topicId: Id, input: { calloutId?: unknown; target?: unknown }): { closed: Id[] } {
    if (typeof input.calloutId === "string" && input.calloutId) {
      const c = this.getCallout(input.calloutId);
      if (c.topicId !== topicId) throw new HostError("bad_request", `callout ${c.id} is not on your topic's canvas`);
      return { closed: c.state === "closed" ? [] : [this.close(c.id).id] };
    }
    const raw = typeof input.target === "string" || typeof input.target === "number" ? String(input.target) : "";
    if (!raw) throw new HostError("bad_request", "give calloutId, or target to close every bubble on that card");
    const target = resolveTarget(this.f.canvases.canvas(topicId), raw);
    return { closed: this.store.listCallouts(topicId).filter((c) => c.target === target).map((c) => this.close(c.id).id) };
  }

  /**
   * 就这条展开聊: a session for the person to talk one item over, in the task of the session that laid it out (else
   * the topic's 主控), beside that session; it starts by reading the item. The item lists it under `threads`.
   */
  async discuss(topicId: Id, itemRef: Id, input: { profileId?: unknown }): Promise<Session> {
    const topic = this.requireTopic(topicId);
    if (topic.archivedAt) throw new HostError("read_only", "the topic is archived");
    const item = findItem(this.f.canvases.canvas(topicId), itemRef);
    if (!item) throw new HostError("not_found", `no review item ${itemRef} on this canvas`);
    const poster = item.sessionId ? this.store.getSession(item.sessionId) : undefined;
    const lead = this.store.listTasks().find((t) => t.topicId === topicId && t.lead && !t.archivedAt);
    const task = (poster?.taskId ? this.store.getTask(poster.taskId) : undefined) ?? lead;
    if (!task || task.archivedAt) throw new HostError("bad_request", "这一条没有可以挂靠的任务：铺它的会话不在任务里，专题也没有主控任务");
    const lastOfTask = this.store.listSessions().filter((s) => s.taskId === task.id && !s.archivedAt && s.kind !== "sub").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const profileId = typeof input.profileId === "string" && input.profileId ? input.profileId : (poster?.profileId ?? lastOfTask?.profileId);
    if (!profileId) throw new HostError("bad_request", "pick a model for the new session");
    this.requireProfile(profileId);
    const text = [
      `【就这条展开聊】专题「${topic.title}」画布上的审阅条目 #${item.num}「${item.title}」（条目 id ${item.id}）。人想就这一条单独深谈，这个会话就是为它开的，人会在这里和你一起推进。`,
      "",
      "条目内容：",
      item.body || "（没有正文）",
      ...(item.refs?.length ? ["", `涉及：${item.refs.join("、")}`] : []),
      "",
      `现在的状态：${statusLabel(item.status)}${item.conclusion ? `；已有结论：${item.conclusion}` : ""}`,
      ...(poster ? [`（这份审阅是会话「${poster.title || "未命名会话"}」（${poster.id}）铺到画布上的。）`] : []),
      "",
      `先用几句话说说你对这一条的理解和需要人确认的点，然后等人说话。聊出结论后，用 canvas_item_update（item: "#${item.num}"）写回结论、改状态${poster ? `；要告诉原来的会话什么，用 mailbox_send 给会话 ${poster.id}` : ""}。`,
    ].join("\n");
    const started = await this.f.tasks.startSession({ taskId: task.id, topicId: null }, this.requireLiveWorkspace(task.workspaceId), { profileId, text });
    const session = await this.f.sessions.renameSession(started.id, `#${item.num} ${item.title}`.slice(0, 100)).catch(() => started);
    this.f.canvases.mutateCanvas(topicId, (doc) => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === item.id && n.kind === "item" ? { ...n, threads: [...(n.threads ?? []), session.id] } : n)) }));
    return session;
  }
}

/** A card or group on the canvas, as the agent named it: "#3", an item/note/reference/group id, or a task with a card. */
function resolveTarget(doc: CanvasDoc, raw: string): Id {
  const ref = raw.trim();
  if (!ref) throw new HostError("bad_request", "target is required: #n for a review item, a task id, or a note's, reference card's or group's id");
  const item = findItem(doc, ref);
  if (item) return item.id;
  if (doc.nodes.some((n) => n.id === ref) || doc.groups.some((g) => g.id === ref)) return ref;
  if (doc.nodes.some((n) => n.kind === "task" && n.taskId === ref)) return ref;
  throw new HostError("bad_request", `nothing on this canvas is ${ref}: give #n for a review item, a task with a card here, or an id from canvas_read`);
}

function optionalText<K extends string>(v: unknown, field: string, max: number, key: K): Partial<Record<K, string>> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "string") throw new HostError("bad_request", `${field} must be text`);
  if (v.length > max) throw new HostError("bad_request", `${field} is too long (at most ${max} characters)`);
  return v.trim() ? ({ [key]: v } as Record<K, string>) : {};
}

function refsOf(v: unknown, field: string): { refs?: string[] } {
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || v.length > 20 || v.some((r) => typeof r !== "string" || !r.trim() || r.length > 500)) throw new HostError("bad_request", `${field} must be a list of at most 20 short texts (paths, commits, links)`);
  return v.length ? { refs: v.map((r: string) => r.trim()) } : {};
}
