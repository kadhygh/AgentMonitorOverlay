// 远程 (plans/remote-session.md, step 1, 2026-10-29): this computer as a device on the team server, the devices paired
// with it, and pairing requests. The Host keeps the connection (features/remote/); 设置 → 远程 and Focus show this.
// Needs the AMO platform's login (%APPDATA%\AMO\account.json): Studio has no login of its own.

import type { ApprovalDecision } from "./api.js";
import type { Id, Session, SessionItem, TaskColumn, Timestamp } from "./entities.js";
import type { QuestionReply } from "./questions.js";

/**
 * off: the Host was started without remote (tests, the Reviewer); no-account: nobody logged in in the AMO platform;
 * connecting / online / offline (retrying at retryAt); unauthorized: the server no longer takes the login;
 * server-old: the team server has no devices channel yet; replaced: another program connected as this device.
 */
export type RemoteConnectionState = "off" | "no-account" | "connecting" | "online" | "offline" | "unauthorized" | "server-old" | "replaced";

export interface RemoteConnection {
  state: RemoteConnectionState;
  /** What went wrong, for the person (offline, unauthorized, server-old, replaced). */
  message: string | null;
  /** When the next attempt is due (offline). */
  retryAt: Timestamp | null;
  /** Since when it is online. */
  since: Timestamp | null;
}

export interface RemoteDevice {
  id: string;
  name: string;
}

/** A paired device. */
export interface RemotePeer {
  account: string;
  device: string;
  name: string;
  /** "owner": this computer allowed it (it may reach this one); "guest": it allowed this computer. */
  role: "owner" | "guest";
  pairedAt: Timestamp;
  /** null: not known (this computer is not connected to the server). */
  online: boolean | null;
  /** When it was last connected, as far as the server knows; null when it has not seen it. */
  lastSeen: Timestamp | null;
}

/** Someone asks to pair with this computer. */
export interface RemoteIncomingRequest {
  id: string;
  account: string;
  device: string;
  name: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** A request this computer sent. Allowed ones become a peer and leave this list. */
export interface RemoteOutgoingRequest {
  id: string;
  to: string;
  state: "pending" | "refused";
  /** The device that refused it. */
  answeredBy: string | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface RemoteState {
  /** This computer (device.json); null until the Host made it (it does when it starts remote). */
  device: RemoteDevice | null;
  /** The AMO platform's login, without the key. */
  account: { server: string; name: string } | null;
  connection: RemoteConnection;
  peers: RemotePeer[];
  incoming: RemoteIncomingRequest[];
  outgoing: RemoteOutgoingRequest[];
  /** Step 2: the tasks this computer granted to paired devices (it is A for them). */
  grants: RemoteGrant[];
  /** Step 2: 远端允许的默认配置 — what sessions started from a paired device may run. */
  allowed: RemoteAllowed;
}

export interface RemotePingResult {
  ok: boolean;
  /** Round trip, when it came back. */
  ms: number | null;
  message: string;
}

/** 刚失联 lasts this long after a device went away; then it is 离线 (Multica's two levels, plans/remote-session.md). */
export const REMOTE_LOST_MS = 5 * 60_000;

export type PeerPresence = "online" | "lost" | "offline" | "unknown";

export const PEER_PRESENCE_LABEL: Record<PeerPresence, string> = { online: "在线", lost: "刚失联", offline: "离线", unknown: "不知道（这台电脑没连上服务器）" };

export function peerPresence(peer: Pick<RemotePeer, "online" | "lastSeen">, now: number = Date.now()): PeerPresence {
  if (peer.online === null) return "unknown";
  if (peer.online) return "online";
  if (peer.lastSeen && now - Date.parse(peer.lastSeen) < REMOTE_LOST_MS) return "lost";
  return "offline";
}

// ---- Step 2 (2026-10-29): A grants a task to a paired device B; B works in it as in a task of its own ------------------
// The task and its sessions stay on A (the original); B keeps a copy in its own Host (Task.remote, sessions with runtime
// "remote") brought up to date from A, and what B does to it goes to A as a command. The frames below are what the two
// Hosts send each other through the team server (which reads no further than the envelope).

/** On B: where a remote task runs, and whether it may still be used. */
export interface TaskRemote {
  /** A: the device the task runs on. */
  account: string;
  device: string;
  /** A's device name, as last heard. */
  name: string;
  /** active: granted; revoked: A took it back, or the pairing ended — readable here until archived, never reached again. */
  state: "active" | "revoked";
  /** Why it was revoked, for the person. */
  reason?: string;
  /** A's models the task's sessions run on, as this computer names them (remoteProfileId), with A's names for them. */
  profiles: Array<{ id: Id; label: string }>;
  /** Of those, what new sessions may start with (A's 远端允许的模型); the first is the default. */
  allowed: Id[];
  grantedAt: Timestamp;
}

/** On A: a task granted to a paired device. */
export interface RemoteGrant {
  taskId: Id;
  account: string;
  device: string;
  /** The device's name, as last heard. */
  name: string;
  grantedAt: Timestamp;
}

/** session_start's permission levels, as remote sessions get them (each runtime's matching permission). */
export const REMOTE_PERMISSIONS = ["read-only", "write", "full"] as const;
export type RemotePermission = (typeof REMOTE_PERMISSIONS)[number];
export const REMOTE_PERMISSION_LABEL: Record<RemotePermission, string> = { "read-only": "只读", write: "可以改文件", full: "完全放开" };

/** On A: 远端允许的默认配置 (设置 → 远程). */
export interface RemoteAllowed {
  /**
   * A's model profiles sessions started from a paired device may use. Empty: only those the task's own sessions already
   * use (the cautious default, 2026-10-29).
   */
  profiles: Id[];
  /** The one offered first; when it is not allowed, the first allowed one. */
  defaultProfile: Id | null;
  /** The permissions those sessions get (also sessions agents start in a granted task); null: the model's own default. */
  permission: RemotePermission | null;
}

export const NO_REMOTE_ALLOWED: RemoteAllowed = { profiles: [], defaultProfile: null, permission: null };

const REMOTE_PROFILE = /^remote:([^:]+):(.+)$/;

/** How B names one of A's model profiles (so it never meets one of its own). */
export const remoteProfileId = (device: string, profileId: Id): Id => `remote:${device}:${profileId}`;

/** The device and A's profile id of a remote profile id; null for a profile of this computer. */
export function parseRemoteProfileId(id: Id): { device: string; profileId: Id } | null {
  const m = REMOTE_PROFILE.exec(id);
  return m ? { device: m[1]!, profileId: m[2]! } : null;
}

/**
 * On A: the tasks whose reminders belong to a paired device now (用户 10-28: 提醒只给 B) — granted to a device that is
 * online, or went away less than REMOTE_LOST_MS ago (刚失联: Focus does not switch back and forth on a short drop).
 * When this computer is not connected (presence unknown) it keeps them: nobody else could act.
 */
export function remoteHeldTasks(state: Pick<RemoteState, "grants" | "peers"> | null, now: number = Date.now()): Set<Id> {
  const held = new Set<Id>();
  if (!state) return held;
  for (const g of state.grants) {
    const peer = state.peers.find((p) => p.account === g.account && p.device === g.device && p.role === "owner");
    if (!peer) continue;
    const p = peerPresence(peer, now);
    if (p === "online" || p === "lost") held.add(g.taskId);
  }
  return held;
}

/** The frame kinds of step 2: B's commands to A, A's answer to each, and what A pushes to B. */
export const REMOTE_KINDS = {
  /** B → A: which of A's tasks are granted to B. → RemoteListAnswer */
  list: "rt.list",
  /** B → A: one granted task with its sessions. {taskId} → RemoteTaskSnapshot */
  task: "rt.task",
  /** B → A: a session's items after `since` (its last seq), in pieces. {sessionId, since} → RemoteItemsAnswer */
  items: "rt.items",
  /** B → A: a message to a session. {sessionId, text} → {mode} */
  send: "rt.send",
  /** B → A: an approval answered; the first answer (here or on A) counts. {sessionId, approvalId, decision} → {ok} */
  approve: "rt.approve",
  /** B → A: a question answered. {sessionId, itemId, reply} → {ok} */
  answer: "rt.answer",
  /** B → A: stop the session's turn. {sessionId} → {ok} */
  interrupt: "rt.interrupt",
  /** B → A: a new session in the task, on an allowed model. {taskId, profileId (A's), text?} → {session} */
  start: "rt.start",
  /** A → B: the answer to a command (`re` is its id). */
  ok: "rt.ok",
  /** A → B: something about a granted task changed (RemotePush). */
  push: "rt.push",
} as const;

/** A's task as B sees it: only what the grant shows (no project, topic or settings of A's). */
export interface RemoteTaskView {
  id: Id;
  title: string;
  description?: string;
  column: TaskColumn;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RemoteTaskSnapshot {
  task: RemoteTaskView;
  /** Every session of the task (its delegated sessions and subagents too), as A has them. */
  sessions: Session[];
  /** A's profiles the task's sessions run on, plus the allowed ones, with their names (A's ids). */
  profiles: Array<{ id: Id; label: string }>;
  /** A's ids of the models B may start sessions with; the first is the default. */
  allowed: Id[];
  grantedAt: Timestamp;
}

export interface RemoteListAnswer {
  tasks: Array<{ taskId: Id; grantedAt: Timestamp }>;
}

export interface RemoteItemsAnswer {
  items: SessionItem[];
  /** More after the last one: ask again from its seq. */
  more: boolean;
}

/** What each command carries. */
export interface RemoteCommandBodies {
  "rt.list": Record<string, never>;
  "rt.task": { taskId: Id };
  "rt.items": { sessionId: Id; since: number };
  "rt.send": { sessionId: Id; text: string };
  "rt.approve": { sessionId: Id; approvalId: string; decision: ApprovalDecision };
  "rt.answer": { sessionId: Id; itemId: Id; reply: QuestionReply };
  "rt.interrupt": { sessionId: Id };
  "rt.start": { taskId: Id; profileId: Id; text?: string };
}

/** A → B, unasked. B checks seq: a gap (or anything it cannot place) makes it ask for what it missed. */
export type RemotePush =
  /** A granted B a task: B asks for it (rt.task). */
  | { type: "granted"; taskId: Id; grantedAt: Timestamp }
  | { type: "revoked"; taskId: Id; reason: string }
  /** The task's title, description or column changed, or what new sessions may run on. */
  | { type: "task"; task: RemoteTaskView; profiles: RemoteTaskSnapshot["profiles"]; allowed: Id[] }
  | { type: "session"; session: Session }
  /** An item appended or changed. */
  | { type: "item"; item: SessionItem }
  /** Streaming text of an agent item (not stored on its own on either side). */
  | { type: "delta"; sessionId: Id; itemId: Id; append: string };
