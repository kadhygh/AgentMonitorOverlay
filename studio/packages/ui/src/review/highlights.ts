import { useEffect, useRef, type RefObject } from "react";
import type { Annotation } from "@amo-studio/protocol";
import { findInRendered, occurrenceInSource } from "./anchor.js";
import { passageTrace } from "../lib/passageTrace.js";

// Annotated passages, highlighted exactly (stage 13, acceptance G2) with the CSS Custom Highlight API: one Range per
// unsent annotation over the quoted text in the rendered reply, painted through `::highlight(amo-annotation)` without
// touching the DOM React owns. When the quote cannot be found again (the reply was edited, the renderer changed), the
// smallest block holding its first words is highlighted instead: a list item, a table cell, a paragraph.

export const ANNOTATION_HIGHLIGHT = "amo-annotation";
export const ANNOTATION_FLASH = "amo-annotation-flash";

/** Each painted annotation's range in this window (one conversation at a time). */
const painted = new Map<string, Range>();

export const highlightsSupported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** The reply's text as the person reads it: text nodes in order, without the copy buttons of code blocks. */
function renderedText(blocks: readonly HTMLElement[]): { text: string; nodes: Array<{ node: Text; at: number }> } {
  let text = "";
  const nodes: Array<{ node: Text; at: number }> = [];
  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      nodes.push({ node: n, at: text.length });
      text += n.data;
    }
  }
  return { text, nodes };
}

const FALLBACK = "li, tr, th, td, p, blockquote, pre, .md-h";

/** The range over an annotation's quote in a rendered reply, or null when none of its blocks are there. */
export function annotationRange(reply: HTMLElement, a: Pick<Annotation, "start" | "end" | "quote">, source: string): Range | null {
  const all = [...reply.querySelectorAll<HTMLElement>("[data-src-start]")];
  const blocks = all.filter((b) => Number(b.dataset.srcStart) < a.end && Number(b.dataset.srcEnd) > a.start);
  if (!blocks.length) return null;
  const { text, nodes } = renderedText(blocks);
  const hit = findInRendered(text, a.quote, occurrenceInSource(source, a.quote, Number(blocks[0]!.dataset.srcStart), a.start));
  const range = document.createRange();
  if (hit && nodes.length) {
    const at = (offset: number, end: boolean) => {
      // The node holding the offset; an end exactly at a node's end stays in that node.
      const i = nodes.findIndex((n, k) => (end ? offset <= n.at + n.node.length : offset < n.at + n.node.length) || k === nodes.length - 1);
      const n = nodes[Math.max(0, i)]!;
      return { node: n.node, offset: Math.min(n.node.length, Math.max(0, offset - n.at)) };
    };
    const s = at(hit.start, false);
    const e = at(hit.end, true);
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  }
  const probe = a.quote.trim().split(/\s+/)[0]?.slice(0, 16) ?? "";
  const holders = blocks.flatMap((b) => [...b.querySelectorAll<HTMLElement>(FALLBACK)]).filter((el) => probe && el.textContent?.includes(probe));
  const smallest = holders.sort((x, y) => (x.textContent?.length ?? 0) - (y.textContent?.length ?? 0))[0] ?? blocks[0]!;
  range.selectNodeContents(smallest);
  return range;
}

/**
 * Paints the unsent annotations of the conversation under `root`, and repaints whenever its DOM changes (streaming,
 * folding a turn, a new reply). `sources`: each agent reply's markdown, by item id.
 */
export function useAnnotationHighlights(root: RefObject<HTMLElement | null>, annotations: readonly Annotation[], sources: ReadonlyMap<string, string>): void {
  const latest = useRef({ annotations, sources });
  latest.current = { annotations, sources };
  const key = annotations.map((a) => `${a.id}:${a.itemId}:${a.start}:${a.end}`).join("|");
  useEffect(() => {
    const el = root.current;
    if (!el || !highlightsSupported()) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      painted.clear();
      const { annotations: list, sources: src } = latest.current;
      for (const a of list) {
        const reply = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(a.itemId)}"]`);
        const source = src.get(a.itemId);
        if (!reply || source === undefined) continue;
        const r = annotationRange(reply, a, source);
        if (r) painted.set(a.id, r);
      }
      CSS.highlights.set(ANNOTATION_HIGHLIGHT, new Highlight(...painted.values()));
      paintListeners.forEach((l) => l());
    };
    paint();
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(paint);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete(ANNOTATION_HIGHLIGHT);
      painted.clear();
    };
  }, [root, key]);
}

const paintListeners = new Set<() => void>();
/** Called after every repaint (the 批注N marks follow the highlights). */
export function onAnnotationsPainted(l: () => void): () => void {
  paintListeners.add(l);
  return () => void paintListeners.delete(l);
}

/** Where each painted annotation ends on screen (its last line box): the 批注N mark goes there. */
export function paintedEnds(): Array<{ id: string; rect: DOMRect }> {
  const out: Array<{ id: string; rect: DOMRect }> = [];
  for (const [id, r] of painted) {
    const boxes = [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
    const last = boxes[boxes.length - 1];
    if (last) out.push({ id, rect: last });
  }
  return out;
}

/** The annotation painted under a point (client coordinates), if any. */
export function annotationAt(x: number, y: number): string | null {
  for (const [id, r] of painted) for (const box of r.getClientRects()) if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return id;
  return null;
}

/** Where a painted annotation is on screen, for the bubble; null when it is not painted. */
export function annotationRect(id: string): DOMRect | null {
  return painted.get(id)?.getBoundingClientRect() ?? null;
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** Scrolls a painted annotation into view and makes it stand out for a moment; false when it is not painted. */
export function flashAnnotation(id: string): boolean {
  const r = painted.get(id);
  if (!r || !highlightsSupported()) return false;
  flashRange(r);
  return true;
}

/** Scrolls a range of the conversation into view and makes it stand out for a moment (a bookmarked passage too). */
export function flashRange(r: Range): void {
  if (!highlightsSupported()) return;
  const el = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
  if (el) scrollToBox(el, r.getBoundingClientRect());
  CSS.highlights.set(ANNOTATION_FLASH, new Highlight(r));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => CSS.highlights.delete(ANNOTATION_FLASH), 1500);
}

/** The text a painted annotation covers (tests and the screen reader label read it). */
export function paintedText(id: string): string | null {
  return painted.get(id)?.toString() ?? null;
}

/**
 * Brings `box` (client coordinates, of something inside `from`) into the middle of the scrolling view around `from`;
 * one taller than the view starts near its top. 2026-10-19: scrollIntoView on the text's element centred the whole
 * element, so a quote late in a long paragraph stayed out of sight; and it scrolls every ancestor, the page too.
 */
export function scrollToBox(from: Element, box: DOMRect): void {
  const scroller = scrollParent(from);
  if (!scroller) return passageTrace("scrollToBox: no scroller");
  const view = scroller.getBoundingClientRect();
  const want = box.height < view.height - 48 ? view.top + (view.height - box.height) / 2 : view.top + 24;
  const was = scroller.scrollTop;
  scroller.scrollTop += box.top - want;
  passageTrace("scrollToBox", { from: Math.round(was), by: Math.round(box.top - want), to: Math.round(scroller.scrollTop), view: Math.round(view.height), box: Math.round(box.height) });
  // The conversation stops following its end now, not at its scroll event a frame later: content growing in between
  // (a turn unfolding, code highlighted) would take it back to the end (2026-10-19: 书签 → 打开对话 landed there).
  scroller.dispatchEvent(new Event(READ_HERE_EVENT));
}

/** On a scroller that was just scrolled to something to read (a passage, an annotation): stay here. */
export const READ_HERE_EVENT = "amo:read-here";

function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
