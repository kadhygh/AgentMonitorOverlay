import type { RelayClient } from "./api.js";
import { dueForAi, type Message, type Thread } from "./protocol.js";
import { sinceLastWord } from "./usage.js";

// `relay inbox` (2026-10-30, plans/done/relay-in-sessions.md): every session one AI conversation sent that came back to its
// person, taken at once — each only what came after their side's last word, and marked as fetched (「AI 已取回」), so the
// next call does not give it again. The conversation is the mark its messages carry (Via.conv); Studio's Host takes its
// own sessions the same way, by the prefix of its marks.

export interface InboxItem {
  thread: Thread;
  fresh: Message[];
  asked: Message | undefined;
}

/** Sessions back with `me` (or taken on with a note for the AI), handled by the AI, not fetched yet, whose conversation `match`es. */
export async function dueSessions(client: RelayClient, me: string, match: (conv: string) => boolean): Promise<Thread[]> {
  return (await client.threads()).filter((t) => {
    const r = t.request;
    return !!r && dueForAi(r, me) && r.conv !== null && match(r.conv);
  });
}

/** Takes one due session: its new part, and marks it fetched; null when nothing new came after all. */
export async function takeSession(client: RelayClient, me: string, threadId: string): Promise<InboxItem | null> {
  const { thread, messages } = await client.messages(threadId, 0, { ai: true });
  // 已接手 with a note for the AI: what is new is that event (sinceLastWord leaves events alone).
  const since = sinceLastWord(messages, me) ?? (thread.request?.takenAt != null && messages.length ? { fresh: messages.slice(-1), asked: undefined } : null);
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
