import { REVEAL_ITEM_EVENT } from "../chat/Transcript.js";
import { scrollToBox } from "../review/highlights.js";
import { flash } from "./ReplyNav.js";

/**
 * Scrolls to a row of the conversation on the page — what came back, an approval that waits, a round picked in 脉络's
 * building — and flashes it (事项清单 2026-11-15; the 会话弹窗 window 2026-11-16). A row in a folded turn, or above what
 * is drawn, is unfolded first and looked for again once it has rendered, `tries` times at most.
 */
export function revealRow(itemId: string, tries: number): void {
  const id = CSS.escape(itemId);
  const row = document.querySelector<HTMLElement>(`[data-row-id="${id}"], [data-item-id="${id}"]`);
  if (!row) {
    if (tries <= 0) return;
    window.dispatchEvent(new CustomEvent(REVEAL_ITEM_EVENT, { detail: itemId }));
    requestAnimationFrame(() => requestAnimationFrame(() => revealRow(itemId, tries - 1)));
    return;
  }
  scrollToBox(row, () => row.getBoundingClientRect());
  flash(row);
}
