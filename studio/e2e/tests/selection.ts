/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";

/** Selects `text` inside `scope` (first match, may span inline elements) and right-clicks on the selection. */
export async function selectAndRightClick(page: Page, scope: Locator, text: string): Promise<void> {
  const box = await select(scope, text);
  await page.mouse.click(box.x, box.y, { button: "right" });
}

/** Selects `text` as a mouse drag would end: the selection, then the button released over it (the bar appears). */
export async function selectAndRelease(scope: Locator, text: string): Promise<void> {
  await select(scope, text);
  await scope.evaluate((root) => {
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: r.right, clientY: r.bottom }));
  });
}

async function select(scope: Locator, text: string): Promise<{ x: number; y: number }> {
  return scope.evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let all = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      all += (n as Text).data;
    }
    const at = all.indexOf(wanted);
    if (at < 0) throw new Error(`text not found: ${wanted}`);
    // A start offset at a node boundary belongs to the next node; an end offset to the previous one.
    const locate = (offset: number, isEnd: boolean) => {
      let pos = 0;
      for (const n of nodes) {
        if (isEnd ? offset <= pos + n.data.length : offset < pos + n.data.length) return { node: n, offset: offset - pos };
        pos += n.data.length;
      }
      const last = nodes.at(-1)!;
      return { node: last, offset: last.data.length };
    };
    const s = locate(at, false);
    const e = locate(at + wanted.length, true);
    const range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
}
