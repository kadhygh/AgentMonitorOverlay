// Turns a DOM selection inside an agent reply into an annotation anchor: the quote, its range in the reply's
// markdown source (LF-normalised), and up to 24 characters of context on each side.

export const CONTEXT_CHARS = 24;

export interface SelectionAnchor {
  itemId: string;
  quote: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

/**
 * Finds the quote in the source, preferring the rendered blocks the selection touched. Rendered text can differ
 * from the source (e.g. `**bold**` renders as "bold"), so whitespace is relaxed and, if nothing matches, the
 * anchor falls back to the whole span of the touched blocks.
 */
export function anchorInSource(source: string, quote: string, blockStart: number, blockEnd: number): { start: number; end: number } {
  const src = source.replace(/\r\n/g, "\n");
  const exact = src.indexOf(quote, blockStart);
  if (exact >= 0 && exact <= blockEnd) return { start: exact, end: exact + quote.length };
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s*_`>|#-]*");
  if (pattern) {
    const re = new RegExp(pattern, "g");
    re.lastIndex = blockStart;
    const m = re.exec(src);
    if (m && m.index <= blockEnd) return { start: m.index, end: m.index + m[0].length };
  }
  return { start: blockStart, end: Math.max(blockStart + 1, blockEnd) };
}

export function contextAround(source: string, start: number, end: number): { prefix: string; suffix: string } {
  const src = source.replace(/\r\n/g, "\n");
  return { prefix: src.slice(Math.max(0, start - CONTEXT_CHARS), start), suffix: src.slice(end, end + CONTEXT_CHARS) };
}

function closestElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Reads the current selection; returns null unless it lies within a single agent reply. */
export function readSelection(sources: ReadonlyMap<string, string>): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString().trim();
  if (!quote) return null;
  const startEl = closestElement(sel.anchorNode);
  const endEl = closestElement(sel.focusNode);
  const reply = startEl?.closest<HTMLElement>("[data-item-id][data-item-type='agent']");
  if (!reply || reply !== endEl?.closest("[data-item-id][data-item-type='agent']")) return null;
  const itemId = reply.dataset.itemId!;
  const source = sources.get(itemId);
  if (source === undefined) return null;
  const blocks = [startEl, endEl].map((el) => el?.closest<HTMLElement>("[data-src-start]")).filter((b): b is HTMLElement => !!b);
  const blockStart = blocks.length ? Math.min(...blocks.map((b) => Number(b.dataset.srcStart))) : 0;
  const blockEnd = blocks.length ? Math.max(...blocks.map((b) => Number(b.dataset.srcEnd))) : source.length;
  const { start, end } = anchorInSource(source, quote, blockStart, blockEnd);
  return { itemId, quote, start, end, ...contextAround(source, start, end) };
}
