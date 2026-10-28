// 渲染批注 (2026-10-28): finding a passage of a rendered document again by its words and their context (the way the
// AMO 中转's notes do, relay-ui/src/anchors.ts). The document's text is read from the DOM as shown, whitespace runs as
// one space, so a passage still matches after the file is regenerated and re-wrapped; several matches: the one whose
// context fits best.
//
// One self-contained function, used twice: called here for rendered Markdown, and its source put into an HTML file's
// frame (frameDoc), which runs the page's scripts and is cut off from this window — so it may refer to nothing outside
// itself.

export interface PassageAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface FlatText {
  /** The text, whitespace runs as one space. */
  text: string;
  /** For each character of `text`: its node and offset there. */
  at: Array<{ node: Text; offset: number }>;
}

export function passageKit(skip = "script, style, noscript, template") {
  const CONTEXT = 24;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  /** The visible text under `root`, without what `skip` matches (a code block's copy button). */
  function flatten(root: Node): FlatText {
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let text = "";
    const at: FlatText["at"] = [];
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

  /** How many characters two strings share at their end (`fromEnd`) or start. */
  function common(a: string, b: string, fromEnd: boolean): number {
    let n = 0;
    while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
    return n;
  }

  /** The occurrence of `quote` in `text` whose context fits best, or -1. */
  function best(text: string, quote: string, prefix: string, suffix: string): number {
    let at = -1;
    let top = -1;
    for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
      const score = common(text.slice(Math.max(0, i - CONTEXT), i), prefix, true) + common(text.slice(i + quote.length, i + quote.length + CONTEXT), suffix, false);
      if (score > top) (at = i), (top = score);
    }
    return at;
  }

  /**
   * Where the passage is in `text` (a flattened document), as [start, end); null when its words are gone. Words
   * re-wrapped can gain or lose a space (a Chinese line broken in two reads with one): then they are matched without.
   */
  function locate(text: string, a: PassageAnchor): { start: number; end: number } | null {
    const quote = norm(a.quote);
    if (!quote) return null;
    const i = best(text, quote, norm(a.prefix), norm(a.suffix));
    if (i >= 0) return { start: i, end: i + quote.length };
    const kept: number[] = [];
    let bare = "";
    for (let k = 0; k < text.length; k++) if (text[k] !== " ") kept.push(k), (bare += text[k]);
    const q = quote.replace(/ /g, "");
    const j = best(bare, q, a.prefix.replace(/\s/g, ""), a.suffix.replace(/\s/g, ""));
    return j >= 0 ? { start: kept[j]!, end: kept[j + q.length - 1]! + 1 } : null;
  }

  /** The passage a selection inside `root` covers: its words and their context; null when it holds no text. */
  function anchorOf(root: Node, range: Range, flat: FlatText = flatten(root)): PassageAnchor | null {
    // The flat characters inside the range.
    let start = -1;
    let end = -1;
    for (let i = 0; i < flat.at.length; i++) {
      const p = flat.at[i]!;
      const c = range.comparePoint(p.node, p.offset);
      if (c < 0) continue;
      if (c > 0 || (p.node === range.endContainer && p.offset >= range.endOffset)) break;
      if (start < 0) start = i;
      end = i + 1;
    }
    if (start < 0) return null;
    const quote = flat.text.slice(start, end).trim();
    if (!quote) return null;
    if (flat.text[start] === " ") start++;
    end = start + quote.length;
    return { quote, prefix: flat.text.slice(Math.max(0, start - CONTEXT), start).trimStart(), suffix: flat.text.slice(end, end + CONTEXT).trimEnd() };
  }

  /** The passage as a Range in `root`; null when its words are not there any more. */
  function rangeOf(root: Node, a: PassageAnchor, flat: FlatText = flatten(root)): Range | null {
    const at = locate(flat.text, a);
    if (!at) return null;
    const first = flat.at[at.start]!;
    const last = flat.at[at.end - 1]!;
    const range = (root.ownerDocument ?? (root as Document)).createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }

  return { CONTEXT, norm, flatten, locate, anchorOf, rangeOf };
}
