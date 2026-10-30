import type { RelayClient } from "./api.js";
import type { Message, Thread } from "./protocol.js";
import { sinceLastWord } from "./usage.js";

// `relay inbox` (2026-10-30, plans/relay-in-sessions.md): every session one AI conversation sent that came back to its
// person, taken at once — each only what came after their side's last word, and marked as fetched (「AI 已取回」), so the
// next call does not give it again. The conversation is the mark its messages carry (Via.conv); Studio's Host takes its
// own sessions the same way, by the prefix of its marks.

export interface InboxItem {
  thread: Thread;
  fresh: Message[];
  asked: Message | undefined;
}

/** Sessions back with `me`, handled by the AI, not fetched yet, whose conversation `match`es. */
export async function dueSessions(client: RelayClient, me: string, match: (conv: string) => boolean): Promise<Thread[]> {
  return (await client.threads()).filter((t) => {
    const r = t.request;
    return !!r && r.from === me && r.state === "returned" && r.waitingOn === me && r.handler === "ai" && r.pickedAt === null && r.conv !== null && match(r.conv);
  });
}

/** Takes one due session: its new part, and marks it fetched; null when nothing new came after all. */
export async function takeSession(client: RelayClient, me: string, threadId: string): Promise<InboxItem | null> {
  const { thread, messages } = await client.messages(threadId, 0, { ai: true });
  const since = sinceLastWord(messages, me);
  return since ? { thread, ...since } : null;
}

export async function takeInbox(client: RelayClient, me: string, match: (conv: string) => boolean): Promise<InboxItem[]> {
  const out: InboxItem[] = [];
  for (const t of await dueSessions(client, me, match)) {
    const item = await takeSession(client, me, t.id);
    if (item) out.push(item);
  }
  return out;
}
