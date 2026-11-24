import type { Id } from "./entities.js";
import type { MatterStatus, PendingKind } from "./matters.js";

// 「待我处理」 in Studio (2026-11-24, plans/collab-framework.md「11-24」第 5 步): one list made of groups, each group from a
// source (来源) the Host registers — 协作 on AMO 中转 (teamrelay, source "cowork") and this computer's own 事项 and mail
// (source "local", the 交流·本机留言和主控 work). Host features/pending gathers them (PendingFeature.register) and the
// workbench's 待我处理 page, the Focus row and the patrol (巡检) read the same snapshot. The rules of what is pending are
// protocol/matters.ts (pendingFor): an @ of me, a 事项 waiting on me, a 事项's message to me, until marked 处理了.

/** Whose list a group is: the person's own, or one of this computer's sessions (a 主控's: what the patrol wakes it for). */
export type PendingFor = { kind: "person" } | { kind: "session"; sessionId: Id };

/** Where the workbench goes when the person clicks an item. */
export type PendingOpen =
  /** The AMO 中转 client (POST /api/cowork/open-in-relay): `cowork:<id>` or `thread:<id>`. */
  | { kind: "relay"; target: string }
  /** A session here (a 事项's 执行, the 主控's conversation). */
  | { kind: "session"; sessionId: Id; taskId: Id | null }
  | { kind: "task"; taskId: Id }
  /** The source's own place on the 待我处理 page (a local 事项 opened in place). */
  | { kind: "here" };

export interface PendingEntry {
  /** Stable within its group across reads (协作: matters.ts pendingItemKey); what marking and the patrol name it by. */
  key: string;
  kind: PendingKind;
  /** One line: 「事项 3 · 标题」 or 「#12 开头…」. */
  text: string;
  /** When it became pending (ms). */
  since: number;
  /** The 事项 it is in; null for an @ in a 群聊 (or mail with no 事项). */
  matter: { id: string; no: number; title: string; status: MatterStatus } | null;
  /** The message (#seq); null for a 事项 waiting on its owner. */
  seq: number | null;
  /** Who it comes from, as shown (「程序老李」「老李 的 AI · 射速」). */
  from?: string;
  open: PendingOpen;
}

export interface PendingGroup {
  /** The source that made it ("cowork", "local"). */
  source: string;
  /** Unique across the snapshot: `<source>:…` (协作: `cowork:<coworkId>:<party>`). */
  id: string;
  /** 「协作「射速调整」」, 「任务「背包」」… */
  title: string;
  for: PendingFor;
  /** A second line, e.g. 「我这一方的主控：射速文档」. */
  note?: string;
  /** Newest first. */
  items: PendingEntry[];
  /** The source takes POST /api/pending/mark for it (看过 / 处理了). */
  canMark: boolean;
}

export interface PendingSnapshot {
  /** Person's groups first, then each session's; a source's order within. */
  groups: PendingGroup[];
  /** Items in the person's own groups: Focus's 「待我处理 N」. */
  mine: number;
  /** Goes up whenever the snapshot's content changes (so a reader compares one number). */
  version: number;
  /** Sources that could not read just now (signed out, 中转 unreachable, an older service), one line each. */
  problems: Array<{ source: string; text: string }>;
}

/** POST /api/pending/mark: 看过 / 处理了 for items of one group (the person's own, or for a session's agent). */
export interface PendingMarkRequest {
  group: string;
  keys: string[];
  mark: "seen" | "handled";
}

/** POST /api/pending/patrol (「让主控现在看一遍」): wake these sessions' 主控 (all, when none given) with their whole list,
 * changed or not — what the 2-minute patrol does only on a change. Sessions in a turn are woken once it ends. */
export interface PendingPatrolRequest {
  sessionIds?: Id[];
}
export interface PendingPatrolResult {
  /** Woken now / once their turn ends / nothing pending for them. */
  woke: Id[];
  later: Id[];
  empty: Id[];
}
