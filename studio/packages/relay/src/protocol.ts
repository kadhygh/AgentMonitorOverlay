// AMO 中转 (Relay, 2026-10-26, plans/relay.md): what the relay service, its clients (the tray program, the MCP) and
// later the UI share. A small team on one LAN; people talk to each other directly, and an AI session can send a
// person a 「请求」 (body + questions) that they answer one by one. Everything is kept on the service.

export const RELAY_APP = "amo-relay";
export const RELAY_VERSION = "0.7.0";
export const RELAY_DEFAULT_PORT = 47120;

export interface Member {
  /** The account name: unique, what everything refers to. */
  name: string;
  /** What they like to be called, shown first (the name after it, faintly); empty when unset. */
  nick: string;
  /** A small picture (data: URL); null = the initial on a colour. */
  avatar: string | null;
  /** What they do, shown to people and to AIs choosing whom to ask, e.g. 「程序 · 战斗」. */
  role: string;
  online: boolean;
  /** ms since epoch; 0 = never seen since the service started. */
  lastSeen: number;
}

/** direct: the one plain chat per pair; topic: more chats between the same two, each about one thing; group: three or
 * more (a direct chat or topic becomes one when someone is @-ed into it, its history with it). */
export type ThreadKind = "direct" | "topic" | "group" | "request";
export type Verdict = "agree" | "change" | "question";
export const VERDICT_LABEL: Record<Verdict, string> = { agree: "同意", change: "需要改", question: "有疑问" };

export interface Question {
  id: string;
  text: string;
  /** Choices to pick from; the person can still write their own answer. */
  options?: string[];
}

export interface Answer {
  questionId: string;
  /** One of the question's options, when they picked one. */
  choice?: string;
  text?: string;
}

/** Who wrote a message: the person, or an AI on their behalf (the client is the MCP client's name, e.g. claude-code). */
export type Via = { kind: "person" } | { kind: "ai"; client?: string };

/** event: a session's state changed (标记完成, 接手, …), written by whoever did it; its body says what happened. */
export type MessageKind = "text" | "request" | "reply" | "event";

export interface Message {
  id: string;
  threadId: string;
  /** The service's global order; also the cursor for reads and waits. */
  seq: number;
  author: string;
  via: Via;
  kind: MessageKind;
  /** Markdown. For a reply, the free text next to the answers. */
  body: string;
  questions?: Question[];
  answers?: Answer[];
  verdict?: Verdict;
  /** The people @-ed in a chat message. */
  mentions?: string[];
  /** Notes on files that came with a reply (copied in when it was sent). */
  notes?: ReplyNote[];
  createdAt: number;
}

/** A session (stage 2a, plans/relay-tasks.md): open = with the person asked, returned = back with the one who asked. */
export type SessionState = "open" | "returned" | "done";

/** What the people in a session can do to it besides writing. */
export type SessionAction = "done" | "reopen" | "handle" | "toAi" | "handoff";

/** A request thread is a session: someone (or their AI) asks a person to handle one thing. */
export interface RequestState {
  from: string;
  to: string;
  /** answered once the person replied; a later reply updates the verdict. */
  status: "open" | "answered";
  verdict: Verdict | null;
  /** The request message's seq. */
  requestSeq: number;
  state: SessionState;
  /** Who acts next; null when done. */
  waitingOn: string | null;
  /** The request was sent by the asker's AI (MCP or command line). */
  byAi: boolean;
  /** The team task it belongs to (stage 2b); null for a session of its own. */
  taskId: string | null;
  /** Who handles the asking side: the AI that sent it, or the person (after 我来处理, or when they sent it). */
  handler: "ai" | "person";
  /** The person asked must reply: they cannot mark it done (all sessions from an AI). */
  needsReply: boolean;
  /** When it last came back to the asking side. */
  returnedAt: number | null;
  /** When the asking side's AI fetched it after that; null while it has not. */
  pickedAt: number | null;
  /** The message whose questions wait for answers (the request, or a follow-up with questions); null after a plain
   * follow-up, which is answered in words. */
  askSeq: number | null;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  /** A request's or topic's title; empty for the direct chat (the other person's name is the title there). */
  title: string;
  members: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  request?: RequestState;
}

/** A thread as one member sees it. */
export interface ThreadView extends Thread {
  unread: number;
  readSeq: number;
  last: Message | null;
  /** Put away by this member (their list only); a new message brings it back. */
  archived: boolean;
}

export interface NewRequest {
  to: string;
  title: string;
  body: string;
  /** Default true; always true from an AI. */
  needsReply?: boolean;
  /** Under this team task. */
  taskId?: string;
  /** Files it takes along (ids of the task's or the asker's files). */
  files?: string[];
  questions?: Array<{ id?: string; text: string; options?: string[] }>;
  via?: Via;
}

export interface NewMessage {
  kind?: "text" | "reply";
  /** In a session, hand it to the other side with this message: the asker asks again (继续追问), the person asked
   * returns it without a form reply. A reply always hands it back. */
  pass?: boolean;
  /** With the asker's pass: a new round of questions to answer one by one (the earlier ones are done). */
  questions?: Array<{ id?: string; text: string; options?: string[] }>;
  body?: string;
  answers?: Answer[];
  verdict?: Verdict;
  /** With a reply: ids of the replier's notes to send along. */
  notes?: string[];
  /** In a chat: who is @-ed (they must be in it; bring others in first with addMembers). */
  mentions?: string[];
  via?: Via;
}

/** Pushed over /ws to the members it concerns. */
// ---- team tasks (stage 2b, plans/relay-tasks.md): a task is always in someone's hands and moves on by 流转.

export const TASK_STATUSES = ["待处理", "开发中", "已完成", "已搁置"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Only these may be archived (归档 is one click on their cards). */
export const ARCHIVABLE: readonly TaskStatus[] = ["已完成", "已搁置"];

export type TaskEventKind = "created" | "edited" | "status" | "transfer" | "archived" | "unarchived" | "session" | "decision" | "file";

/** One line of a task's 记录. A decision is what a session's reply settled (answers and verdict). */
export interface TaskEvent {
  id: number;
  taskId: string;
  at: number;
  actor: string;
  via: Via;
  kind: TaskEventKind;
  text: string;
  data?: { to?: string; from?: string; status?: TaskStatus; reason?: string; threadId?: string; fileId?: string };
}

/** A session under a task as everyone on the team sees it; its messages are for its two people. */
export interface TaskSession {
  id: string;
  title: string;
  from: string;
  to: string;
  byAi: boolean;
  state: SessionState;
  waitingOn: string | null;
  updatedAt: number;
}

export interface Task {
  id: string;
  title: string;
  /** Markdown. */
  description: string;
  status: TaskStatus;
  /** Who has it now. */
  holder: string;
  creator: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  sessions: TaskSession[];
  /** The latest version of each file. */
  files: RelayFile[];
  /** The last time it was handed to someone (流转, or made for someone else). */
  handoff: { eventId: number; from: string; to: string; by: string; at: number; status: TaskStatus; reason: string } | null;
}

/** A task as one member sees it: `unseen` = handed to me and I have not opened it since. */
export interface TaskView extends Task {
  unseen: boolean;
}

export interface NewTask {
  title: string;
  description?: string;
  holder?: string;
  status?: TaskStatus;
  via?: Via;
}

/** Shared by the team, edited by anyone: the flow AIs are told, 流程速查's keywords, when an AI counts as slow. */
export interface TeamSettings {
  flow: string;
  /** The team's flow document (an HTML or Markdown file anyone uploads a new version of); the service fills it in. */
  flowDoc?: RelayFile | null;
  /** Whether the flow document runs its own scripts when opened (its 复制提示词 buttons need them). */
  flowScripts: boolean;
  /** 推进方式 and other phrases to copy. */
  keywords: string[];
  aiLateMinutes: number;
  aiStuckMinutes: number;
}

export const DEFAULT_SETTINGS: TeamSettings = {
  flow: `1. 策划新建团队任务，写 designdoc 并上传到任务。
2. 把「复制任务提示词」贴给 AI 初审；需要程序确认的，AI 用 relay_session_open 在任务下发会话给程序，问题里带上「推进方式」三选一。
3. 程序在待处理里回复并返回，或者接手任务。
4. 策划的 AI 用 relay_session_get 取回复，按选定的推进方式继续；完成后用 relay_task_transfer 流转给程序终审（状态：待处理）。
5. 程序终审通过后把任务标为已完成，并归档。`,
  keywords: ["策划在主分支直接推进", "策划拉独立分支，完成后程序合并", "程序接手开发"],
  aiLateMinutes: 10,
  aiStuckMinutes: 30,
  flowScripts: true,
};

// ---- files and notes (stages 2c, 2d)

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A file in a task (the team sees it) or in a session (its two people do); a new upload of the same name in the same
 * place is its next version. */
export interface RelayFile {
  id: string;
  name: string;
  version: number;
  /** How many versions there are of this name in this place. */
  versions: number;
  size: number;
  type: string;
  sha256: string;
  by: string;
  at: number;
  taskId: string | null;
  threadId: string | null;
  /** A file of the team's rather than of a task or a session: "flow" for the flow document. */
  slot: string | null;
  /** Notes on this version. */
  notes: number;
}

/** A passage of a file (its words, and some of the text before and after to find it again) and what someone thinks. */
export interface FileNote {
  id: string;
  fileId: string;
  /** The version it was written on. */
  version: number;
  author: string;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  at: number;
}

export interface ReplyNote {
  noteId: string;
  fileId: string;
  file: string;
  version: number;
  author: string;
  quote: string;
  body: string;
}

/** The service's /ws tick: a client that hears nothing for a while knows it is gone. */
export const TICK_MS = 20_000;

export type RelayEvent =
  | { type: "hello"; me: string; client: string | null }
  | { type: "message"; thread: Thread; message: Message }
  | { type: "members"; members: Member[] }
  | { type: "read"; threadId: string; readSeq: number }
  /** A new thread with no message yet (a topic): to its members. */
  | { type: "thread"; thread: Thread }
  /** A team task changed (made, edited, handed over, a session under it moved): to everyone. */
  | { type: "task"; task: Task }
  /** The team's settings changed: to everyone. */
  | { type: "settings"; settings: TeamSettings }
  /** Notes on a file changed: to whoever can see the file. */
  | { type: "notes"; fileId: string }
  /** I am no longer in this thread (left a group): to my devices. */
  | { type: "left"; threadId: string }
  /** A thread changed without a message (a session fetched by an AI): to its members. */
  | { type: "updated"; thread: Thread }
  /** This member archived or brought back a thread (their other devices follow). */
  | { type: "archived"; threadId: string; archived: boolean }
  /** A new client build was published: clients update themselves. */
  | { type: "client"; version: string | null }
  /** Every TICK_MS, so a client notices a service that went away without closing (a sleeping machine, the network). */
  | { type: "tick" };

export interface Health {
  app: typeof RELAY_APP;
  version: string;
  name: string;
  /** Registering takes the invite passphrase. */
  invite: boolean;
  /** The client content's version the service hands out; null = none. */
  client: string | null;
  /** The desktop program the service hands out (downloads/AMO-Relay-win.zip): a client running another build can
   * update itself to it (更新桌面程序). Null = none. */
  shell?: ShellBuild | null;
  /** The devices channel (devices-protocol.ts, remote sessions): its version; missing on a service from before it. */
  devices?: number;
}

export interface ShellBuild {
  build: string;
  size: number;
  sha256: string;
}

/** client/manifest.json: the client content the desktop client downloads and keeps (its hot update). */
export interface ClientManifest {
  version: string;
  builtAt: number;
  /** The oldest desktop shell this content runs in; an older shell has to be downloaded again. */
  minShell: number;
  files: Array<{ path: string; size: number; sha256: string }>;
}
