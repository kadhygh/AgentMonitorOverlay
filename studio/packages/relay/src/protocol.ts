// AMO 中转 (Relay, 2026-10-26, plans/relay.md): what the relay service, its clients (the tray program, the MCP) and
// later the UI share. A small team on one LAN; people talk to each other directly, and an AI session can send a
// person a 「请求」 (body + questions) that they answer one by one. Everything is kept on the service.

export const RELAY_APP = "amo-relay";
export const RELAY_VERSION = "0.2.0";
export const RELAY_DEFAULT_PORT = 47120;

export interface Member {
  name: string;
  /** What they do, shown to people and to AIs choosing whom to ask, e.g. 「程序 · 战斗」. */
  role: string;
  online: boolean;
  /** ms since epoch; 0 = never seen since the service started. */
  lastSeen: number;
}

export type ThreadKind = "direct" | "request";
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

export type MessageKind = "text" | "request" | "reply";

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

export interface RequestState {
  from: string;
  to: string;
  /** open until the person replies; a later reply updates the verdict. */
  status: "open" | "answered";
  verdict: Verdict | null;
  /** The request message's seq. */
  requestSeq: number;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  /** A request's title; empty for a direct chat (the other person's name is the title there). */
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
}

export interface NewRequest {
  to: string;
  title: string;
  body: string;
  questions?: Array<{ id?: string; text: string; options?: string[] }>;
  via?: Via;
}

export interface NewMessage {
  kind?: "text" | "reply";
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
