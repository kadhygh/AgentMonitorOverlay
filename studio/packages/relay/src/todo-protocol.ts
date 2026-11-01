// 待办 (2026-11-01, plans/todo.md): the todo lists of an account, kept by the team server so every device of the account
// sees them. Each device has a list of its own (`device:<id>`, the id in %APPDATA%\AMO\device.json) and the account has
// one shared by all its devices (`shared`); every device of the account may read and change every list. The 便签
// program keeps a copy and a queue of changes made while the server could not be reached, and sends them later.
//
//   GET  /api/todo?device=<id>&deviceName=<name>&since=<rev>   the changes after `since` (0: everything), the devices
//   POST /api/todo/ops {device, deviceName, ops: TodoOp[]}      applies the changes in order; bad ones are skipped
//
// Conflicts: the last change to reach the server wins, field by field (a put only names what it changes). A deleted
// item stays deleted: a put for it (from a device that was away) is ignored. Deleted items are kept as marks for
// TODO_TOMBSTONE_DAYS so devices that were away learn of them; a device further behind gets everything again (`full`).

export const TODO_SHARED = "shared";
export const TODO_TEXT_MAX = 500;
/** Items an account may have (not counting deleted ones). */
export const TODO_ITEMS_MAX = 3000;
/** Changes one request may carry. */
export const TODO_OPS_MAX = 500;
export const TODO_TOMBSTONE_DAYS = 30;
export const TODO_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** `shared`, or `device:<device id>`. */
export type TodoListId = string;

export interface TodoItem {
  id: string;
  list: TodoListId;
  text: string;
  done: boolean;
  /** Smaller first. New items go on top (below the smallest); a moved one between its new neighbours. */
  order: number;
  createdAt: number;
  updatedAt: number;
  /** When it was ticked (null while not done): 已完成保留 counts from here. */
  doneAt: number | null;
  /** The device that added it, and its name then. */
  byDevice: string;
  byName: string;
  deleted: boolean;
  /** The account's change counter when it last changed. */
  rev: number;
}

/** A device of the account that has used 待办: its list shows in the others' 其他 ▾. */
export interface TodoDevice {
  device: string;
  name: string;
  seenAt: number;
}

export type TodoOp = { op: "put"; id: string; list?: TodoListId; text?: string; done?: boolean; order?: number } | { op: "delete"; id: string };

export interface TodoSnapshot {
  rev: number;
  /** Changed after `since` (deleted ones as marks); everything there is when `full`. */
  items: TodoItem[];
  devices: TodoDevice[];
  /** The whole state, not changes: the copy is replaced (since was 0, or older than the marks kept). */
  full: boolean;
}

export interface TodoOpsResult {
  rev: number;
  /** The changes that could not be applied (and never will be): the device drops them from its queue. */
  rejected: Array<{ index: number; message: string }>;
}
