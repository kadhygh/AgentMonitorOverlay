// Finding a note's passage in a shown document again (stage 2d): the note keeps its words (quote) and up to CONTEXT
// characters before and after; the document's text is read from the DOM as shown, whitespace runs taken as one space,
// so a passage still matches after a new version re-wraps it. Several matches: the one whose context fits best.
// Highlights use the CSS Custom Highlight API, so the document's DOM is never changed.

export const CONTEXT = 24;

interface Flat {
  /** The text, whitespace runs as one space. */
  text: string;
  /** For each character of `text`: its node and offset there. */
  at: Array<{ node: Text; offset: number }>;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The visible text under `root` (scripts and styles left out). */
export function flatten(root: Node): Flat {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = "";
  const at: Flat["at"] = [];
  let space = true;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const s = n.data;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (/\s/.test(c)) {
        if (space) continue;
        space = true;
        text += " ";
      } else {
        space = false;
        text += c;
      }
      at.push({ node: n, offset: i });
    }
  }
  return { text, at };
}

/** Where a selection inside `root` sits: its words and their context, for a new note. */
export function anchorOf(root: Node, range: Range): { quote: string; prefix: string; suffix: string } | null {
  const quote = norm(range.toString());
  if (!quote) return null;
  const flat = flatten(root);
  // The flat index of the range's start: the first character at or after it.
  let start = flat.at.findIndex((p) => {
    const c = range.comparePoint(p.node, p.offset);
    return c >= 0;
  });
  if (start < 0) start = flat.text.indexOf(quote);
  const end = start + quote.length;
  return { quote, prefix: flat.text.slice(Math.max(0, start - CONTEXT), start).trimStart(), suffix: flat.text.slice(end, end + CONTEXT).trimEnd() };
}

/** The best place of a note's words in `root`, as a Range; null when the words are not there any more. */
export function findAnchor(root: Node, a: { quote: string; prefix?: string; suffix?: string }, flat = flatten(root)): Range | null {
  const quote = norm(a.quote);
  if (!quote) return null;
  let best = -1;
  let bestScore = -1;
  for (let i = flat.text.indexOf(quote); i >= 0; i = flat.text.indexOf(quote, i + 1)) {
    const before = flat.text.slice(Math.max(0, i - CONTEXT), i);
    const after = flat.text.slice(i + quote.length, i + quote.length + CONTEXT);
    const score = common(before, norm(a.prefix ?? ""), true) + common(after, norm(a.suffix ?? ""), false);
    if (score > bestScore) (best = i), (bestScore = score);
  }
  if (best < 0) return null;
  const first = flat.at[best]!;
  const last = flat.at[best + quote.length - 1]!;
  const doc = root.ownerDocument ?? (root as Document);
  const range = doc.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** How many characters two strings share at their end (`fromEnd`) or start. */
function common(a: string, b: string, fromEnd: boolean): number {
  let n = 0;
  while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
  return n;
}

/** Paints the ranges (all notes) and the hot one, in the window the document lives in. */
export function paint(win: Window | null, ranges: Range[], hot: Range | null): void {
  const reg = (win as (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null)?.CSS?.highlights;
  const H = (win as (Window & { Highlight?: new (...r: Range[]) => unknown }) | null)?.Highlight;
  if (!reg || !H) return;
  reg.set("relay-note", new H(...ranges));
  if (hot) reg.set("relay-note-hot", new H(hot));
  else reg.delete("relay-note-hot");
}

/** The styles for those highlights, for a document of its own (an iframe). */
export const HIGHLIGHT_CSS = "::highlight(relay-note){background:rgba(196,140,40,.28)}::highlight(relay-note-hot){background:rgba(196,140,40,.6)}";
