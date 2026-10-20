// Rows drawn only near the screen (2026-10-20): DiffView mounts a chunk's rows while the chunk is within reach of the
// view, so a 3000-line file is a few hundred elements instead of 33 000. Whatever goes to a row by its element (open
// at a line, Ctrl+G, Ctrl+F, n / p, a located comment, the place kept across views) asks for it here first: the
// chunk holding it is drawn, then the element is there.

type Revealer = (rows: readonly number[]) => Promise<void>;

const revealers = new WeakMap<Element, Revealer>();

/** The view's chunks (`.gr-chunks`) draw the chunks holding `rows` when asked; returns what unregisters it. */
export function registerRevealer(host: Element, reveal: Revealer): () => void {
  revealers.set(host, reveal);
  return () => {
    if (revealers.get(host) === reveal) revealers.delete(host);
  };
}

/** Row `row`'s element (`data-row`) in the view under `scroller`, its chunk drawn first if it was not. */
export async function revealRow(scroller: ParentNode, row: number): Promise<HTMLElement | null> {
  const selector = `[data-row="${row}"]`;
  const drawn = scroller.querySelector<HTMLElement>(selector);
  if (drawn) return drawn;
  const host = scroller.querySelector(".gr-chunks");
  const reveal = host ? revealers.get(host) : undefined;
  if (!reveal) return null;
  await reveal([row]);
  return scroller.querySelector<HTMLElement>(selector);
}

/** The nearest ancestor that scrolls vertically (the chunks' IntersectionObserver root), or null for the page. */
export function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
}
