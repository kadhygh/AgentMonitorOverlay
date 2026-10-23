import type { ReviewOpenTarget, ViewPack, ViewItem } from "@amo-studio/protocol";

// Pure logic of the 查看包 window (2026-10-23): which pack a tool call opened, which item to show when the pack
// grows, and the message temporary comments on a proposal go back as.

/** The pack a view_open (or review_open) call made, from its output; null for any other call. */
export function packIdOf(toolName: string, output: string | undefined): string | null {
  if (!/(^|[_.])(view_open|review_open)$/.test(toolName) || !output) return null;
  return /"packId"\s*:\s*"(vp-[\w-]{1,80})"/.exec(output)?.[1] ?? null;
}

/**
 * The Review a review_open call opened on a whole project (no pack): its target, from the call's output, so the
 * conversation's row can open it again (2026-10-23); null for anything else.
 */
export function reviewTargetOf(toolName: string, output: string | undefined): ReviewOpenTarget | null {
  if (!/(^|[_.])review_open$/.test(toolName) || !output) return null;
  try {
    const parsed = JSON.parse(output) as { target?: Partial<ReviewOpenTarget> } | null;
    const t = parsed?.target;
    if (!t || typeof t.workspaceId !== "string" || !t.workspaceId) return null;
    return t as ReviewOpenTarget;
  } catch {
    return null;
  }
}

/**
 * The item to show after the pack changed: the first item that was not in it before (the agent just added it), else
 * the one shown, else the first.
 */
export function itemToShow(before: ViewPack | null, after: ViewPack, current: string | null): string | null {
  const had = new Set(before?.items.map((i) => i.id) ?? []);
  const added = before ? after.items.find((i) => !had.has(i.id)) : undefined;
  if (added) return added.id;
  if (current && after.items.some((i) => i.id === current)) return current;
  return after.items[0]?.id ?? null;
}

/** A comment written on a 改动预览 for this one look: on the proposed file (new) or the original (old). */
export interface ProposalComment {
  id: string;
  side: "new" | "old";
  line: number;
  lineText: string;
  note: string;
}

/** The message that carries a proposal's comments back to the conversation. */
export function proposalMessage(pack: Pick<ViewPack, "title">, item: Extract<ViewItem, { kind: "proposal" }>, comments: readonly ProposalComment[]): string {
  const lines = [...comments]
    .sort((a, b) => a.line - b.line || a.side.localeCompare(b.side))
    .map((c) => `- ${c.side === "new" ? "改后" : "原文件"}第 ${c.line} 行 \`${c.lineText.trim().slice(0, 120)}\`：${c.note}`);
  return [`【对改动预览的批注】${item.path}（查看包「${pack.title}」）`, ...lines].join("\n");
}
