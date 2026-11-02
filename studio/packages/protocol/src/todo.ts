// 待办 (2026-11-01, plans/todo.md): what the 便签 program's 待办 window and its main process share. The lists live on the
// team server (packages/relay/src/todo-protocol.ts, the same shapes); the program keeps a copy and the changes not sent
// yet, and shows the copy with those changes on top.

export const TODO_SHARED_LIST = "shared";
export const todoDeviceList = (deviceId: string) => `device:${deviceId}`;
export const TODO_TEXT_LIMIT = 500;
/** 已完成保留 (days; 0 = 一直留着). */
export const TODO_KEEP_CHOICES = [7, 30, 90, 0] as const;
export const TODO_KEEP_DEFAULT = 30;

export interface TodoEntry {
  id: string;
  /** `shared` or `device:<id>`. */
  list: string;
  text: string;
  done: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  byDevice: string;
  byName: string;
  deleted: boolean;
  rev: number;
}

export interface TodoDevice {
  device: string;
  name: string;
  seenAt: number;
}

/** One change, as the server takes it: a put names only what it changes (a new item: list, text and order). */
export type TodoOp = { op: "put"; id: string; list?: string; text?: string; done?: boolean; order?: number } | { op: "delete"; id: string };

/**
 * - off: 使用待办 is turned off in the settings
 * - signed-out: no login here (or it ran out): 在 AMO 平台里登录
 * - syncing / synced: talking to the server / all sent and fetched
 * - offline: the server cannot be reached; changes wait in the queue
 * - error: the server answered with something else (message says what)
 */
export type TodoStatus = "off" | "signed-out" | "syncing" | "synced" | "offline" | "error";

/**
 * An item bound to a Studio task (and maybe one of its sessions), 2026-11-02 (问题 #10): bound from the task's or the
 * session's ⋯ in Studio, the tag after the item opens it there. Kept on this computer only (the program's copy, not the
 * server): the task is in this computer's Studio, other devices could not open it anyway.
 */
export interface TodoLink {
  taskId: string;
  taskTitle: string;
  sessionId?: string;
  sessionTitle?: string;
  boundAt: number;
  /** Studio said the task (or the session) is not there any more. */
  gone?: boolean;
}

/** What the 待办 window shows (GET /api/todo of the 便签 program). */
export interface TodoView {
  status: TodoStatus;
  /** Why it is signed out, offline or failed; a change the server would not take. */
  message: string | null;
  /** The account the lists belong to (null when signed out). */
  account: { server: string; name: string } | null;
  /** This computer. */
  device: { id: string; name: string };
  /** The items (not deleted) with the changes not sent yet on top. */
  items: TodoEntry[];
  /** The account's devices that used 待办, this one included. */
  devices: TodoDevice[];
  /** Changes waiting to be sent. */
  pending: number;
  /** A copy for this account has been fetched at least once (before that, an empty list means nothing yet). */
  loaded: boolean;
  /** 已完成保留 (days; 0 = 一直留着). */
  keepDays: number;
  /** Items bound to a Studio task, by item id (only items still there). */
  links: Record<string, TodoLink>;
  /** Studio runs on this computer and is linked to the program: a tag can be opened there. */
  studio: boolean;
}

/**
 * Applies changes to a copy, as the server would: field by field, deleted stays deleted, a put for an item not there
 * makes it (when it says list and text). `by` and `now` stand for the server's stamps until the real ones come back.
 */
export function applyTodoOps(items: ReadonlyMap<string, TodoEntry>, ops: readonly TodoOp[], by: { device: string; name: string }, now: number): Map<string, TodoEntry> {
  const out = new Map(items);
  for (const op of ops) {
    const have = out.get(op.id);
    if (op.op === "delete") {
      if (have && !have.deleted) out.set(op.id, { ...have, deleted: true, updatedAt: now });
      continue;
    }
    if (have) {
      if (have.deleted) continue;
      const done = op.done ?? have.done;
      out.set(op.id, {
        ...have,
        list: op.list ?? have.list,
        text: op.text ?? have.text,
        order: op.order ?? have.order,
        done,
        doneAt: op.done === undefined ? have.doneAt : op.done ? (have.done ? have.doneAt : now) : null,
        updatedAt: now,
      });
      continue;
    }
    if (op.list === undefined || op.text === undefined) continue;
    out.set(op.id, { id: op.id, list: op.list, text: op.text, done: op.done ?? false, order: op.order ?? 0, createdAt: now, updatedAt: now, doneAt: op.done ? now : null, byDevice: by.device, byName: by.name, deleted: false, rev: 0 });
  }
  return out;
}

/** A list's items in their order: not done first (by order, then newest), done after (latest ticked first). */
export function sortTodo(items: readonly TodoEntry[]): { open: TodoEntry[]; done: TodoEntry[] } {
  const open = items.filter((i) => !i.done).sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  const done = items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return { open, done };
}

/** The order for a new item on top of a list. */
export const todoOrderOnTop = (open: readonly TodoEntry[]) => (open.length ? Math.min(...open.map((i) => i.order)) - 1 : 0);

/** The order for an item put between two (either may be missing: top or bottom). */
export function todoOrderBetween(before: TodoEntry | undefined, after: TodoEntry | undefined): number {
  if (before && after) return (before.order + after.order) / 2;
  if (before) return before.order + 1;
  if (after) return after.order - 1;
  return 0;
}

/** A new item's id: `t_` + 16 hex digits. */
export function newTodoId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `t_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
