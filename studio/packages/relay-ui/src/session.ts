import { useEffect, useState, useSyncExternalStore } from "react";
import { RelayClient, type Member, type Message, type RelayEvent, type ThreadView } from "./shared.js";

// One login: the client with its key, the thread list and the people, kept current by /ws (reconnecting, and
// reloading what it missed). Views subscribe; a thread view also hears each new message.

export interface Identity {
  server: string;
  name: string;
  role: string;
  key: string;
  service: string;
}

export type Connection = "connecting" | "online" | "offline";

interface State {
  threads: ThreadView[];
  members: Member[];
  connection: Connection;
}

export class Session {
  readonly client: RelayClient;
  private state: State = { threads: [], members: [], connection: "connecting" };
  private listeners = new Set<() => void>();
  private messageListeners = new Set<(m: Message) => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  /** The thread on screen: its messages count as read while the window has focus. */
  openThread: string | null = null;

  constructor(readonly me: Identity) {
    this.client = new RelayClient(me.server, me.key);
  }

  get snapshot(): State {
    return this.state;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onMessage(listener: (m: Message) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.reload();
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  async reload(): Promise<void> {
    const [threads, members] = await Promise.all([this.client.threads(), this.client.members()]);
    this.set({ threads, members });
  }

  private connect(): void {
    if (this.closed) return;
    const url = `${this.me.server.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(this.me.key)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      const missed = this.retry > 0;
      this.retry = 0;
      this.set({ connection: "online" });
      if (missed) void this.reload().catch(() => undefined);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as RelayEvent);
    ws.onclose = () => {
      if (this.closed) return;
      this.set({ connection: "offline" });
      this.retry++;
      setTimeout(() => this.connect(), Math.min(15_000, 1000 * 2 ** Math.min(this.retry, 4)));
    };
  }

  private handle(e: RelayEvent): void {
    if (e.type === "members") this.set({ members: e.members });
    else if (e.type === "read") {
      this.set({ threads: this.state.threads.map((t) => (t.id === e.threadId ? { ...t, readSeq: e.readSeq, unread: 0 } : t)) });
    } else if (e.type === "message") {
      const mine = e.message.author === this.me.name;
      const old = this.state.threads.find((t) => t.id === e.thread.id);
      const view: ThreadView = {
        ...e.thread,
        last: e.message,
        readSeq: mine ? e.message.seq : (old?.readSeq ?? 0),
        unread: mine ? 0 : (old?.unread ?? 0) + 1,
      };
      this.set({ threads: [view, ...this.state.threads.filter((t) => t.id !== e.thread.id)] });
      for (const l of this.messageListeners) l(e.message);
    }
  }

  /** Marks the thread read up to its last message (local first, then the service). */
  markRead(threadId: string): void {
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!t || (t.unread === 0 && t.readSeq >= t.lastSeq)) return;
    this.set({ threads: this.state.threads.map((x) => (x.id === threadId ? { ...x, unread: 0, readSeq: x.lastSeq } : x)) });
    void this.client.read(threadId).catch(() => undefined);
  }

  /** A thread the list does not have yet (a new direct chat): put it in. */
  adopt(view: ThreadView): void {
    if (this.state.threads.some((t) => t.id === view.id)) return;
    this.set({ threads: [view, ...this.state.threads] });
  }
}

export function useSession(session: Session): State {
  return useSyncExternalStore(session.subscribe, () => session.snapshot);
}

/** Re-renders every minute, for "3 分钟前". */
export function useMinuteTick(): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}
