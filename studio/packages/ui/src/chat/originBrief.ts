import type { MessageOrigin } from "@amo-studio/protocol";

/**
 * What a folded message from an agent or from Studio shows (OriginMessage): its text without Markdown marks, and
 * without the lines written for the model only — a 中转 reply opens with how to go on and which threadId, and closes
 * with how to answer; the person skimming wants what the other side said.
 */
export function originBrief(origin: MessageOrigin, body: string): string {
  let text = body;
  if (origin.kind === "team")
    text = text
      .replace(/\n\n（AMO Studio 从中转转回来的，[\s\S]*）\s*$/, "")
      .replace(/^[^\n]*(?:回复了你发的会话|已接手你发的会话)[^\n]*\n+/gm, "")
      .replace(/^#{1,6} 会话：[^\n]*\n[^\n]*threadId[^\n]*\n+/gm, "");
  return text
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/\*{1,3}|`/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 360);
}
