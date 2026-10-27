import type { SessionItem } from "@amo-studio/protocol";

// 停止 right after sending (2026-10-28): the message usually lacked something or wants rewording, so the composer gets
// it back, the way the Claude Code CLI does. Only while nothing has come back for it yet: thinking may have started, but
// no reply text, tool call, question or subagent.

/** What still counts as nothing having come back. */
const QUIET = new Set<SessionItem["type"]>(["turn", "notice", "reasoning", "compaction", "suggestion"]);

/** The last message's text when nothing has answered it yet, else null. */
export function unansweredPrompt(items: readonly SessionItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === "user") return it.text.trim() ? it.text : null;
    if (it.type === "agent" ? !!it.markdown.trim() : !QUIET.has(it.type)) return null;
  }
  return null;
}
