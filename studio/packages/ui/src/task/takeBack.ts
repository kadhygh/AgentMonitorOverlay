import { messageOrigin, type SessionItem } from "@amo-studio/protocol";

// 停止 right after sending (2026-10-28): the message usually lacked something or wants rewording, so the composer gets
// it back, the way the Claude Code CLI does. Only while nothing has come back for it yet: thinking may have started, but
// no reply text, tool call, question or subagent.

/** What still counts as nothing having come back. */
const QUIET = new Set<SessionItem["type"]>(["turn", "notice", "reasoning", "compaction", "suggestion"]);

/** The last message's text when nothing has answered it yet, else null. */
export function unansweredPrompt(items: readonly SessionItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    // Held in the inbox (2026-11-04): not the person's words, and it goes in after the stop anyway — looked past.
    if (it.type === "user" && it.delivery === "held") continue;
    // From an agent or from Studio and already in (2026-11-15, MessageOrigin): a sub-session's report, a 中转 reply — not
    // the person's words either; the turn it started is theirs to stop, not its text to take back.
    if (it.type === "user" && messageOrigin(it)) return null;
    // Still waiting (立即发送, 2026-11-02): it goes to the model after the stop anyway, so it is not taken back.
    if (it.type === "user") return it.text.trim() && it.delivery !== "waiting" ? it.text : null;
    if (it.type === "agent" ? !!it.markdown.trim() : !QUIET.has(it.type)) return null;
  }
  return null;
}
