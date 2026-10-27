// AMO 中转 (Relay, 2026-10-26, plans/relay.md): what the relay service, its clients (the tray program, the MCP) and
// later the UI share. A small team on one LAN; people talk to each other directly, and an AI session can send a
// person a 「请求」 (body + questions) that they answer one by one. Everything is kept on the service.

export const RELAY_APP = "amo-relay";
export const RELAY_VERSION = "0.3.0";
export const RELAY_DEFAULT_PORT = 47120;

export interface Member {
  name: string;
  /** What they do, shown to people and to AIs choosing whom to ask, e.g. 「程序 · 战斗」. */
  role: string;
  online: boolean;
  /** ms since epoch; 0 = never seen since the service started. */
  lastSeen: number;
}

/** direct: the one plain chat per pair, always there; topic: more chats between the same two, each about one thing. */
export type ThreadKind = "direct" | "topic" | "request";
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
  /** Who handles the asking side: the AI that sent it, or the person (after 我来处理, or when they sent it). */
  handler: "ai" | "person";
  /** The person asked must reply: they cannot mark it done (all sessions from an AI). */
  needsReply: boolean;
  /** When it last came back to the asking side. */
  returnedAt: number | null;
  /** When the asking side's AI fetched it after that; null while it has not. */
  pickedAt: number | null;
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
  questions?: Array<{ id?: string; text: string; options?: string[] }>;
  via?: Via;
}

export interface NewMessage {
  kind?: "text" | "reply";
  /** In a session, hand it to the other side with this message: the asker asks again (继续追问), the person asked
   * returns it without a form reply. A reply always hands it back. */
  pass?: boolean;
  body?: string;
  answers?: Answer[];
  verdict?: Verdict;
  via?: Via;
}

/** Pushed over /ws to the members it concerns. */
/** The service's /ws tick: a client that hears nothing for a while knows it is gone. */
export const TICK_MS = 20_000;

export type RelayEvent =
  | { type: "hello"; me: string; client: string | null }
  | { type: "message"; thread: Thread; message: Message }
  | { type: "members"; members: Member[] }
  | { type: "read"; threadId: string; readSeq: number }
  /** A new thread with no message yet (a topic): to its members. */
  | { type: "thread"; thread: Thread }
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
}

/** client/manifest.json: the client content the desktop client downloads and keeps (its hot update). */
export interface ClientManifest {
  version: string;
  builtAt: number;
  /** The oldest desktop shell this content runs in; an older shell has to be downloaded again. */
  minShell: number;
  files: Array<{ path: string; size: number; sha256: string }>;
}
