// 远程 (plans/done/remote-session.md, step 1, 2026-10-29): this computer as a device on the team server, the devices paired
// with it, and pairing requests. The Host keeps the connection (features/remote/); the remote page (顶栏「远程」, 设置 → 远程 until 2026-10-29) and Focus show this.
// Needs the AMO platform's login (%APPDATA%\AMO\account.json): Studio has no login of its own.

import type { ApprovalDecision } from "./api.js";
import type { AccountUsage, Id, Session, SessionItem, TaskColumn, Timestamp } from "./entities.js";
import type { ChannelBalance } from "./channels.js";
import type { QuestionReply } from "./questions.js";
import { composeGitReviewMessage } from "./gitreview.js";

/**
 * off: the Host was started without remote (tests, the Reviewer); no-account: nobody logged in in the AMO platform;
 * disabled: logged in, but the person has not turned remote on (2026-10-30: off until they do, per account);
 * connecting / online / offline (retrying at retryAt); unauthorized: the server no longer takes the login;
 * server-old: the team server has no devices channel yet; replaced: another program connected as this device.
 */
export type RemoteConnectionState = "off" | "no-account" | "disabled" | "connecting" | "online" | "offline" | "unauthorized" | "server-old" | "replaced";

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
  /** The account asked. */
  to: string;
  /**
   * 2026-10-29 (远程页的配对弹窗): the one device of that account asked, picked from its online devices — only it may
   * answer. Absent: any device of the account (asked by account name, or an older team server).
   */
  toDevice?: { device: string; name: string };
  state: "pending" | "refused";
  /** The device that refused it. */
  answeredBy: string | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface RemoteState {
  /**
   * 2026-10-30 (the user: 默认关闭，手动开启才开，未登录无法开启): whether the person turned remote on for the account
   * logged in now. Off, this computer does not connect to the team server as a device; pairs and grants are kept.
   */
  enabled: boolean;
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
  /** Step 4, as A: tasks paired devices ask this computer to run, waiting for an answer. */
  taskRequests: RemoteTaskRequest[];
  /** Step 4, as B: what this computer asked paired devices to run, and their answers (until put away). */
  asks: RemoteTaskRequest[];
  /** 远端允许的项目 (plans/done/remote-page-and-new-task.md 4.1, 2026-10-29): where paired devices may create tasks here. */
  allowedProjects: RemoteAllowedProjects;
  /** 安全 (2026-10-29): whether a task a paired device creates here starts at once or waits for a yes here. */
  security: RemoteSecurity;
  /**
   * As B (2026-11-01, the user: 重连后先读条，一次性同步好): paired devices whose granted tasks this computer is catching
   * up on after being away, once it has taken more than a moment; empty otherwise. Optional: an older Host has none.
   */
  syncing?: RemoteSyncing[];
  /**
   * As B (远程额度, 2026-11-06): the quota of the models the copies' sessions run on, as the computers they run on last
   * read it (pushed, never asked for). Optional: an older Host has none.
   */
  usage?: RemotePeerUsage[];
  /**
   * As A (远程额度, 2026-11-06, the user): paired devices of other accounts the person let see this computer's quota
   * (远程 → 已配对的设备 →「让它看我的模型额度」, off by default). Devices of this computer's own account see it anyway.
   * Optional: an older Host has none.
   */
  usageShare?: Array<{ account: string; device: string }>;
}

/**
 * 远程额度 (2026-11-06, the user: 被控端追踪了这个模型的额度，就直接显示被控端的信息): what A has read of its own
 * quota, for the models of the tasks it granted this device — cached numbers only (A never asks its accounts for B), and
 * only accounts with numbers. Profile ids are A's in the push; B keeps them as its copies' (remoteProfileId).
 */
export interface RemoteUsage {
  /** Subscriptions (Claude, GPT): the account in use, as A last read it (updatedAt set, at least one window). */
  usage: AccountUsage[];
  /** Channels with a balance query: A's last answer that worked. */
  balances: ChannelBalance[];
}

/** One paired device's quota as this computer last heard it (in memory: gone when this Host restarts until A pushes again). */
export interface RemotePeerUsage extends RemoteUsage {
  account: string;
  device: string;
  /** When it came. */
  receivedAt: Timestamp;
}

/** One paired device's tasks being brought up to date here: `done` of `total` tasks; `taskId` the one under way. */
export interface RemoteSyncing {
  account: string;
  device: string;
  name: string;
  done: number;
  total: number;
  taskId: Id | null;
}

/** Another device of this computer's own account, connected to the team server now (远程页的配对弹窗, 2026-10-29). */
export interface RemoteOnlineDevice {
  device: string;
  name: string;
  /** Since when it is connected. */
  since: Timestamp;
}

export interface RemoteOnlineDevices {
  devices: RemoteOnlineDevice[];
  /** false: the team server cannot list them yet (its relay service is older); pairing by account name still works. */
  supported: boolean;
}

export interface RemotePingResult {
  ok: boolean;
  /** Round trip, when it came back. */
  ms: number | null;
  message: string;
}

/** 刚失联 lasts this long after a device went away; then it is 离线 (Multica's two levels, plans/done/remote-session.md). */
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

/** On A: 远端允许的默认配置 (远程页 → 远程设置). */
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
  /** B → A: a message to a session; `now`: 立即发送 (2026-11-02; an older A ignores it and queues). {sessionId, text, now?} → {mode} */
  send: "rt.send",
  /** B → A (立即发送, 2026-11-02): a waiting message of the session goes to the model now. {sessionId, itemId} → {ok} */
  sendNow: "rt.sendNow",
  /** B → A (2026-11-02): a message the session's process never read goes again. {sessionId, itemId} → {mode} */
  resend: "rt.resend",
  /** B → A: an approval answered; the first answer (here or on A) counts. {sessionId, approvalId, decision} → {ok} */
  approve: "rt.approve",
  /** B → A: a question answered. {sessionId, itemId, reply} → {ok} */
  answer: "rt.answer",
  /** B → A: stop the session's turn. {sessionId} → {ok} */
  interrupt: "rt.interrupt",
  /** B → A (2026-10-30): a new name for the task ({taskId, title}) or one of its sessions ({sessionId, title}). → {ok} */
  rename: "rt.rename",
  /** B → A (2026-10-30): archive one session (its branches with it), or restore it. {sessionId, archived} → {ok} */
  archive: "rt.archive",
  /** B → A: a new session in the task, on an allowed model. {taskId, profileId (A's), text?} → {session} */
  start: "rt.start",
  /**
   * Step 3, B → A: a file of a granted task (HTML, Markdown or an image, under the task's folder or among its
   * attachments), one piece at a time. RemoteFileAsk → RemoteFileAnswer
   */
  file: "rt.file",
  /** Step 4, B → A: please run a task for me (RemoteTaskRequestAsk); A's person allows or refuses it later. → {request} */
  request: "rt.request",
  /** Step 4, B → A: B takes a request back, or puts A's answer to it away. {requestId} → {ok} */
  withdraw: "rt.withdraw",
  /** B → A: B archived its copy of a granted task — the grant ends, A stops telling B about it. {taskId} → {ok} */
  drop: "rt.drop",
  /** B → A (新任务页的远程模式, 2026-10-29): where B may create a task on A and on which models. {} → RemoteCatalog */
  catalog: "rt.catalog",
  /**
   * B → A: create a task there now (no one on A says yes: 远端允许的项目 and 远端允许的模型 limit it), granted to B,
   * its session started with `text`. RemoteCreateAsk → RemoteCreateAnswer
   */
  create: "rt.create",
  /**
   * B → A (2026-10-29 evening): one piece of a file B sends along with a message, a new session or a task it creates
   * there — a picture or any file. The command that carries the message then names it (RemoteUpload). RemoteUploadAsk →
   * {received}
   */
  upload: "rt.upload",
  /**
   * B → A (2026-10-31, the user: 「远程控制端可能看到被控端的模板」): the prompt templates a granted task's composer
   * offers there (A's global ones and its project's). {taskId} → {templates: PromptTemplate[]}
   */
  templates: "rt.templates",
  /**
   * B → A (2026-10-31, 问题 #1: the new-task page's 「在别的设备上」 had no @): the templates a task created there from
   * the catalog would offer — A's global ones, and the picked project's (`workspaceId`, one of the allowed; null: the
   * common folder, global ones only). {workspaceId} → {templates: PromptTemplate[]}. Lower case: the server forwards
   * only kinds of [a-z0-9._-] (FRAME_KIND_RE).
   */
  createTemplates: "rt.create-templates",
  /**
   * B → A (远程 Reviewer, plans/done/remote-reviewer.md, 2026-11-02): one read of the Reviewer on a granted task — its 查看包,
   * the Git Review of its project, a file a pack names — as B's Reviewer asked its own Host for it. A checks it against
   * the grant and the task's folder. RemoteViewAsk → RemoteViewAnswer
   */
  view: "rt.view",
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
  /** Step 4: the asking device's requests as A has them (an older A leaves it out). */
  requests?: RemoteTaskRequest[];
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
  "rt.send": { sessionId: Id; text: string; uploads?: RemoteUpload[] };
  "rt.approve": { sessionId: Id; approvalId: string; decision: ApprovalDecision };
  "rt.answer": { sessionId: Id; itemId: Id; reply: QuestionReply };
  "rt.interrupt": { sessionId: Id };
  "rt.start": { taskId: Id; profileId: Id; text?: string; uploads?: RemoteUpload[] };
  "rt.file": RemoteFileAsk;
  "rt.request": RemoteTaskRequestAsk;
  "rt.withdraw": { requestId: string };
  "rt.drop": { taskId: Id };
  "rt.catalog": Record<string, never>;
  "rt.create": RemoteCreateAsk;
  "rt.upload": RemoteUploadAsk;
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
  | { type: "delta"; sessionId: Id; itemId: Id; append: string }
  /** Step 4: A's person answered one of B's requests. */
  | { type: "request"; request: RemoteTaskRequest }
  /**
   * 2026-10-30 (the user: B's new-task page kept the old projects after A saved 远端允许的项目): what B may pick creating
   * a task on A changed — sent to a device that asked for it (rt.catalog) since A's Host started. An older B ignores it.
   */
  | { type: "catalog"; catalog: RemoteCatalog }
  /**
   * 远程 Reviewer (2026-11-02): an agent of the task opened a 查看包 (`packId`, at `itemId`) or a Review of the task's
   * project (`review`) for the person, in a turn this device's message started: it shows here. An older B ignores it.
   */
  | { type: "open"; taskId: Id; sessionId: Id; packId?: Id; itemId?: Id; review?: import("./gitreview.js").ReviewOpenTarget }
  /**
   * 远程额度 (2026-11-06): A's cached quota of the models the tasks granted to this device run on, all of it each time
   * (it replaces what B had). Sent when it changes, and again after B asks for its list or a task. Only to a device of
   * A's own account. An older B ignores it.
   */
  | ({ type: "usage" } & RemoteUsage);

// ---- Step 3 (2026-10-29): B looks at a remote task's files ---------------------------------------------------------
// A link in a remote task's conversation opens in B's viewer: B's Host asks A for the file (rt.file), A checks it is under
// the task's folder (links and junctions resolved first) or one of its attachments, that it is HTML, Markdown, an
// image or text, and not too big, and sends it in pieces. B keeps it in its own data folder, by task, and opens it from there; the
// same file unchanged is not sent again. Paths between the two say where in the task's folder, never A's user folder.

/** Biggest file B may take from A. */
export const REMOTE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** One piece of a file (base64 in a frame of at most 1 MB). */
export const REMOTE_FILE_CHUNK = 512 * 1024;
// ---- 2026-10-29 evening (the user): B sends pictures and files to A ----------------------------------------------
// With a message in a remote task, a new session there, or a task B creates on A. B's Host sends each file in pieces
// (rt.upload) before the command; A keeps them as attachments of its own (pictures as pictures the model sees, other
// files in its attachments folder, named in the message's 引用文件 block with A's path). Pieces nobody claims go after
// an hour. An older A does not know rt.upload: B says to update it.

/** Biggest file B may send A (as a picture attached here). */
export const REMOTE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Biggest total one message, session or task may carry. */
export const REMOTE_UPLOAD_TOTAL_BYTES = 60 * 1024 * 1024;

/** B → A: a piece of a file, at `offset` of `size` bytes (base64). The first piece starts it, the last ends it. */
export interface RemoteUploadAsk {
  /** B's id for it (up_…). */
  uploadId: string;
  name: string;
  size: number;
  offset: number;
  data: string;
}

/** A file B sent, named in the command that carries it. */
export interface RemoteUpload {
  uploadId: string;
  name: string;
  /** A picture the model sees (its type); absent: a file A lists in the message's 引用文件 block. */
  mime?: string;
  /** A marked range and note of the file, kept in the block. */
  startLine?: number | null;
  endLine?: number | null;
  note?: string;
}

/** How paths name A's task folder for B (instead of A's own path, which has the user's name in it). */
export const REMOTE_TASK_FOLDER = "任务文件夹";
/** How paths name the task's attachments (pictures sent in its conversation) for B. */
export const REMOTE_ATTACHMENTS_FOLDER = "附件";

/**
 * `text` (2026-10-29, the user: B should open what a page links to, as A's viewer does — scripts, configs, logs): any
 * other file whose start has no NUL byte (A checks), shown as the viewer shows text, at most MAX_TEXT_FILE_BYTES.
 */
export type RemoteFileKind = "html" | "markdown" | "image" | "text";
const REMOTE_FILE_EXT: Record<string, RemoteFileKind> = {
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".svg": "image",
  ".ico": "image",
};

/** Known not to be text: said on B at once instead of asking A (A refuses any file with a NUL byte anyway). */
const REMOTE_BINARY_EXT = new Set(
  ".exe .dll .pdb .lib .obj .o .a .so .dylib .bin .dat .db .sqlite .zip .7z .rar .gz .tgz .tar .xz .zst .iso .msi .apk .ipa .jar .class .pyc .wasm .pdf .doc .docx .xls .xlsx .ppt .pptx .psd .tga .tif .tiff .exr .hdr .dds .ktx .fbx .blend .mp3 .wav .ogg .flac .aac .mp4 .mov .avi .mkv .webm .ttf .otf .woff .woff2 .bundle .unity3d .bytes".split(" "),
);

/** What kind of file remote viewing takes, by extension (`text` for any other, unless known to be binary); null for those. */
export function remoteFileKind(path: string): RemoteFileKind | null {
  const p = path.trim().replace(/[\\/]+$/, "");
  if (!p) return null;
  const m = /\.[^./\\]+$/.exec(p);
  const ext = m ? m[0].toLowerCase() : "";
  if (REMOTE_BINARY_EXT.has(ext)) return null;
  return REMOTE_FILE_EXT[ext] ?? "text";
}

/** B → A: a piece of a file of a granted task. */
export interface RemoteFileAsk {
  taskId: Id;
  /** As the conversation names it: A's absolute path, `任务文件夹/…`, or relative (to `cwd`, else the task's folder). */
  path: string;
  /** Where a relative `path` starts (a command's working directory as B has it), when not the task's folder. */
  cwd?: string;
  /** The first byte wanted (0 for the start). */
  offset: number;
  /** B's kept copy: A answers `unchanged` when the file is still the same. */
  have?: { size: number; mtime: number; sha256: string };
  /** After the first piece: the file as it was then; changed since, A says so and B starts again. */
  expect?: { size: number; mtime: number };
}

export interface RemoteFileAnswer {
  /** Where the file is in the task's folder (`docs/a.md`), or `附件/<name>`; forward slashes. */
  rel: string;
  size: number;
  /** Modified, ms since 1970. */
  mtime: number;
  /** Of the whole file; on the first piece (and with `unchanged`). */
  sha256?: string;
  kind: RemoteFileKind;
  /** B's copy is the file as it is: nothing sent. */
  unchanged?: true;
  /** The piece: from `offset`, base64. */
  offset?: number;
  data?: string;
}

/** On B: a remote task's file, fetched (or found unchanged) and kept here (POST /api/remote/files). */
export interface RemoteFetchedFile {
  /** The copy on this computer (in the data folder, by task). */
  path: string;
  /** Where it is in the task's folder, as A said. */
  rel: string;
  kind: RemoteFileKind;
  size: number;
  /** A's device name. */
  device: string;
  /** Served from the copy here without a transfer (A said it is unchanged, or A could not be reached: `stale`). */
  cached: boolean;
  /** A could not be reached (or the grant is gone): this is the copy fetched last time — why. */
  stale?: string;
  /** For pages that load the task's images: `/api/remote/files/<key>/<rel>` serves them (fetched from A as asked). */
  key: string;
}

// ---- 远程 Reviewer (plans/done/remote-reviewer.md, 2026-11-02): B looks at a remote task's 查看包 and Review --------------
// B's Reviewer windows on a remote task talk to their own Host as usual, through `/api/remote/view/<task>/…` instead of
// `/api/…`; B's Host passes each read on to A (rt.view) and keeps the answer, shown again (said to be old) while A is
// away. A answers only what the Reviewer reads — the task's packs, git of the task's project (read only), files a pack
// names or the changes list — checked against the grant and the task's folder (links and junctions resolved first).
// Paths in the answers name the task's folder (任务文件夹/…), never A's own. Comments stay on B.

/** B → A: one Reviewer read. */
export interface RemoteViewAsk {
  taskId: Id;
  /** The route as B's Reviewer asked it: `GET` or `POST`, `/api/workspaces/<A's id>/git/status`, its query and body. */
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** A later piece of a big answer: the id the first piece gave and where to go on. */
  piece?: { id: string; offset: number };
}

/** A → B: the answer as JSON (UTF-8, base64), whole or in pieces; `id` with the first piece when more follow. */
export interface RemoteViewAnswer {
  size: number;
  offset: number;
  data: string;
  id?: string;
}

/** Biggest Reviewer answer B takes from A (a big diff). */
export const REMOTE_VIEW_MAX_BYTES = 20 * 1024 * 1024;

// ---- Step 4 (2026-10-29): B asks A to run a task ------------------------------------------------------------------
// B writes a title and what to do (the first message); A's person sees it on Focus and on the remote page, picks the
// project, topic and model (from 远端允许的模型) and allows it — A makes the task, starts its session with that message
// and grants it to B — or refuses it, saying why. Only while A is online: the team server keeps no requests.

export interface RemoteTaskRequestAsk {
  /** B's id for it (rq_…), so a request sent twice is one. */
  id: string;
  title: string;
  /** What to do: the task's first message. */
  text: string;
}

export type RemoteTaskRequestState = "pending" | "accepted" | "refused";

/** A request for a task, as both sides see it (on A from a device, on B to one). */
export interface RemoteTaskRequest {
  id: string;
  title: string;
  text: string;
  /** The other side: on A the device that asked, on B the device asked. */
  account: string;
  device: string;
  name: string;
  state: RemoteTaskRequestState;
  /** Refused: what A's person wrote (may be empty). */
  reason?: string;
  /** Accepted: the task made on A (B's copy has the same id). */
  taskId?: Id;
  createdAt: Timestamp;
  answeredAt?: Timestamp;
  /**
   * 安全 (2026-10-29): a task the device created from its new-task page that waits for a yes here — where it goes and the
   * model, as picked there (the accept dialog starts from them). Absent: a request (the device only wrote what to do).
   */
  preset?: { workspaceId: Id | null; topicId: Id | null; profileId: Id };
  /** What B sent along with it (kept on A until it is allowed or refused): pictures by A's attachment id, files by A's path. */
  attached?: { images: Array<{ id: Id; name: string }>; files: Array<{ id: Id; path: string; name: string; startLine?: number | null; endLine?: number | null; note?: string }> };
}

/** On A: what allowing a request needs — where the task goes and the model its session runs on. */
export interface RemoteAcceptInput {
  workspaceId: Id;
  topicId?: Id | null;
  profileId: Id;
}

// ---- 远程创建 (plans/done/remote-page-and-new-task.md 4.1, 2026-10-29): B creates a task on A from its new-task page ----------
// The user (10-29): nobody on A says yes; A's 远程设置 limits it instead — 远端允许的项目 (and whether 「不选项目（公共
// 文件夹）」 is allowed) beside 远端允许的模型. Nothing ticked there: remote create is not available. B asks A for what it
// may pick (rt.catalog), then creates (rt.create): A makes the task, grants it to B and starts its session with the
// first sentence — the same path an allowed request (step 4) takes.

/** On A: 远端允许的项目. Neither a project nor `common`: paired devices cannot create tasks here. */
export interface RemoteAllowedProjects {
  /** A's projects (workspace ids) paired devices may create tasks in. */
  workspaceIds: Id[];
  /** Whether 「不选项目（公共文件夹）」 is allowed too. */
  common: boolean;
}

export const NO_REMOTE_PROJECTS: RemoteAllowedProjects = { workspaceIds: [], common: false };

/** Whether a paired device may create tasks on this computer at all. */
export const remoteCreateOpen = (p: RemoteAllowedProjects | null | undefined): boolean => !!p && (p.workspaceIds.length > 0 || p.common);

/** A → B: what B may pick creating a task on A (rt.catalog). Ids are A's own. */
export interface RemoteCatalog {
  /** A's device name. */
  name: string;
  /** A's live topics, most recently worked in first; `workspaceIds`: its projects (编辑专题's 常用项目 and its tasks'), only allowed ones. */
  topics: Array<{ id: Id; title: string; workspaceIds: Id[]; lastUsed: Timestamp | null }>;
  /** Only the allowed projects, most recently worked in first. */
  projects: Array<{ id: Id; name: string; lastUsed: Timestamp | null }>;
  /** 「不选项目（公共文件夹）」 allowed. */
  allowCommon: boolean;
  /** 远端允许的模型 (A's ids, with A's names for them), the default first; usable ones only. */
  models: Array<{ id: Id; label: string }>;
  /** 安全 (2026-10-29): what B creates waits for a yes on A (absent from an older A: it starts at once). */
  confirm?: boolean;
}

/** B → A: the task to create (rt.create). */
export interface RemoteCreateAsk {
  /** Empty: from the first sentence, as here. */
  title?: string;
  /** The first sentence: the session's first message. */
  text: string;
  topicId: Id | null;
  /** null: no project (the common folder), when A allows it. */
  workspaceId: Id | null;
  /** One of A's 远端允许的模型 (A's id). */
  profileId: Id;
  /** Pictures and files sent before it (rt.upload). */
  uploads?: RemoteUpload[];
}

/**
 * A → B: the task made (B's copy has the same id). `error`: the task is there and granted, but its session did not start.
 * `waiting` (安全, 2026-10-29): nothing made yet — A's 远程设置 → 安全 wants a yes there first; the request A keeps
 * (`taskId` is then null; an older B, which does not know `waiting`, finds the request in its list after a reconnect).
 */
export interface RemoteCreateAnswer {
  taskId: Id | null;
  sessionId: Id | null;
  error?: string;
  waiting?: RemoteTaskRequest;
}

// ---- 安全 (2026-10-29, the user): who may start tasks here without a yes ------------------------------------------
// A paired device logged in with this computer's own account is the person's other computer: what it creates starts at
// once (as 远程创建 did from the start). A device of another account: what it creates waits for a yes here (Focus, 远程),
// like a request — unless the person turns that off. Requests and tasks granted from here are not affected.

/** `run`: starts at once. `confirm`: waits for a yes on this computer. */
export type RemoteStart = "run" | "confirm";

export interface RemoteSecurity {
  /** Devices logged in with this computer's account. */
  sameAccount: RemoteStart;
  /** Devices of other accounts. */
  otherAccount: RemoteStart;
}

export const DEFAULT_REMOTE_SECURITY: RemoteSecurity = { sameAccount: "run", otherAccount: "confirm" };

/** How a task created from `account`'s device starts here. */
export const remoteStartFor = (security: RemoteSecurity, own: string | null | undefined, account: string): RemoteStart => (own && own === account ? security.sameAccount : security.otherAccount);

/** On B: POST /api/remote/create's answer. `copied`: the copy is on this computer already (else it follows shortly). */
export interface RemoteCreateResult extends RemoteCreateAnswer {
  copied: boolean;
}

// ---- Wrapping up step 2 (2026-10-29): A while it is used from another device -------------------------------------

/**
 * On A: the devices tasks are granted to that are online now, with how many tasks each (for 完全退出's question and for
 * keeping this computer awake while it is used from another). Empty when nothing is in use.
 */
export function remoteInUse(state: Pick<RemoteState, "grants" | "peers" | "connection"> | null): Array<{ name: string; tasks: number }> {
  if (!state || state.connection.state !== "online") return [];
  const by = new Map<string, { name: string; tasks: number }>();
  for (const g of state.grants) {
    const peer = state.peers.find((p) => p.account === g.account && p.device === g.device && p.role === "owner");
    if (!peer?.online) continue;
    const key = `${g.account}\n${g.device}`;
    const had = by.get(key);
    by.set(key, { name: peer.name || g.name, tasks: (had?.tasks ?? 0) + 1 });
  }
  return [...by.values()];
}

/** 完全退出's line about remote use (2026-10-29), or null when nothing is used from another device. */
export function remoteQuitNote(inUse: ReadonlyArray<{ name: string; tasks: number }>): string | null {
  if (!inUse.length) return null;
  const n = inUse.reduce((sum, x) => sum + x.tasks, 0);
  return `有 ${n} 个任务正被 ${inUse.map((x) => x.name).join("、")} 远程使用，退出后那边会暂停。`;
}

/**
 * 远程 Reviewer 的批注 (2026-11-02, the user): what the controlling computer wrote on a remote task's files and changes
 * (kept there, never sent to the task's computer as comments). Copied out (`copy`), the paths start at 任务文件夹/ —
 * never that computer's own folder, which has its user's name in it — and the project is named by that computer;
 * sent to the task's conversation (发到对话), they are as its session reads them, relative to the task's folder.
 */
export function composeRemoteReviewMessage(comments: Parameters<typeof composeGitReviewMessage>[0], device: string, copy: boolean): string {
  if (!copy) return composeGitReviewMessage(comments, REMOTE_TASK_FOLDER);
  const under = (p: string) => (p === REMOTE_TASK_FOLDER || p.startsWith(`${REMOTE_TASK_FOLDER}/`) ? p : `${REMOTE_TASK_FOLDER}/${p.replace(/\\/g, "/").replace(/^\.?\//, "")}`);
  return composeGitReviewMessage(
    comments.map((c) => ({ ...c, path: under(c.path), ...(c.passage?.source ? { passage: { ...c.passage, source: under(c.passage.source) } } : {}) })),
    device ? `${device} 上的${REMOTE_TASK_FOLDER}` : REMOTE_TASK_FOLDER,
  );
}

// ---- Host routes (declared here, part of api.ts's HostRoutes) --------------------------------------------------

/** 远程 (2026-10-29, plans/done/remote-session.md): this computer as a device, pairing, granted tasks, remote creation. */
export interface RemoteRoutes {
  "GET /api/remote": { req: void; res: RemoteState };
  /** Renames this computer (device.json, shared with the AMO platform). */
  "PUT /api/remote/device": { req: { name: string }; res: RemoteState };
  /** 2026-10-30: turns remote on or off for the account logged in now (on needs the AMO platform's login). */
  "PUT /api/remote/enabled": { req: { enabled: boolean }; res: RemoteState };
  /**
   * Asks account `account` to pair with this computer; a device of it allows or refuses. `device` (远程页的配对弹窗,
   * 2026-10-29): only that device of the account, picked from GET /api/remote/devices/online.
   */
  "POST /api/remote/pair": { req: { account: string; device?: string }; res: RemoteState };
  /** The other devices of this computer's account connected to the team server now (the pair dialog lists them). */
  "GET /api/remote/devices/online": { req: void; res: RemoteOnlineDevices };
  /** Allows or refuses a request to pair with this computer. */
  "POST /api/remote/requests/:id/answer": { req: { allow: boolean }; res: RemoteState };
  /** Withdraws a request this computer sent, or puts a refusal away. */
  "DELETE /api/remote/requests/:id": { req: void; res: RemoteState };
  /** Ends the pairing with a device (both sides forget it). */
  "POST /api/remote/unpair": { req: { account: string; device: string }; res: RemoteState };
  /** 测试连接: a round trip to a paired device through the server. */
  "POST /api/remote/ping": { req: { account: string; device: string }; res: RemotePingResult };
  /** Tries to connect now (after a failure, without waiting for the next attempt). */
  "POST /api/remote/reconnect": { req: void; res: RemoteState };
  /** Step 2: grants a task (and every session in it) to a device this computer allowed to pair. */
  "POST /api/remote/grants": { req: { taskId: Id; account: string; device: string }; res: RemoteState };
  /** Step 2: takes a grant back (the device keeps what it has, readable, and reaches the task no more). */
  "POST /api/remote/grants/revoke": { req: { taskId: Id; account: string; device: string }; res: RemoteState };
  /** Step 2: 远端允许的默认配置. */
  "PUT /api/remote/allowed": { req: RemoteAllowed; res: RemoteState };
  /**
   * Step 3, on B: a file of a remote task, fetched from the computer it runs on (or found unchanged) and kept in this
   * computer's data folder. `fetchId` names the remote.file events that say how far it came.
   */
  "POST /api/remote/files": { req: { taskId: Id; path: string; cwd?: string; fetchId?: string }; res: RemoteFetchedFile };
  /** Step 4, on B: asks a paired device (one that allowed this computer) to run a task — only while it is online. */
  "POST /api/remote/asks": { req: { account: string; device: string; title: string; text: string }; res: RemoteState };
  /** Step 4, on B: takes a request back (still waiting), or puts an answer away. */
  "DELETE /api/remote/asks/:id": { req: void; res: RemoteState };
  /** Step 4, on A: allows a request — the task is made where asked, its session starts with the request, and it is granted. */
  "POST /api/remote/task-requests/:id/accept": { req: RemoteAcceptInput; res: RemoteState };
  /** Step 4, on A: refuses a request, saying why (or not). */
  "POST /api/remote/task-requests/:id/refuse": { req: { reason?: string }; res: RemoteState };
  /** 远程创建 (2026-10-29), on A: 远端允许的项目 — where paired devices may create tasks on this computer. */
  "PUT /api/remote/allowed-projects": { req: RemoteAllowedProjects; res: RemoteState };
  /** 安全 (2026-10-29): which paired devices' tasks start without a yes here. */
  "PUT /api/remote/security": { req: RemoteSecurity; res: RemoteState };
  /** 远程额度 (2026-11-06), on A: whether a paired device of another account sees this computer's quota (off: it is cleared there at once). */
  "PUT /api/remote/usage-share": { req: { account: string; device: string; on: boolean }; res: RemoteState };
  /** 远程创建, on B: what a paired device (one that allowed this computer) lets this computer pick creating a task there. `?account=&device=` */
  "GET /api/remote/catalog": { req: void; res: RemoteCatalog };
  /** 远程创建, on B (问题 #1): the device's templates for a task created there in that project (rt.createTemplates). `?account=&device=&workspace=` (no workspace: the common folder) */
  "GET /api/remote/catalog/prompt-templates": { req: void; res: import("./prompt-templates.js").PromptTemplate[] };
  /** A remote copy's templates as its own computer offers them (rt.templates). */
  "GET /api/remote/tasks/:id/prompt-templates": { req: void; res: import("./prompt-templates.js").PromptTemplate[] };
  /**
   * 远程 Reviewer (2026-11-02): the key a remote copy's pictures are served under (/api/remote/files/<key>/…), for the
   * Markdown and HTML a 查看包 of it shows rendered.
   */
  "GET /api/remote/tasks/:id/files-key": { req: void; res: { key: string } };
  /** 远程创建, on B: creates a task on that device, granted to this computer and running; answers once the copy is here (or after a while). */
  "POST /api/remote/create": { req: RemoteCreateAsk & { account: string; device: string; /** Pictures uploaded here (POST /api/attachments); files go in the text's 引用文件 block. */ attachments?: Id[] }; res: RemoteCreateResult };
}
