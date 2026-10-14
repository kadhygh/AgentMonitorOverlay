// Where an annotation's quote sits in the rendered text of a reply (stage 13, acceptance G2): stage 2 highlighted every
// block the annotation touched, so one line chosen in a list lit up the whole list. Pure functions; the DOM side is in
// highlights.ts.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (quote: string) => quote.trim().split(/\s+/).filter(Boolean).map(escape);

/** The quote in markdown source: words with any whitespace or markup between them (as selection.ts anchors it). */
export function sourcePattern(quote: string): RegExp | null {
  const w = words(quote);
  return w.length ? new RegExp(w.join("[\\s*_`>|#-]*"), "g") : null;
}

/** The quote in rendered text: words with any whitespace between them, or none (text nodes of two cells meet). */
export function renderedPattern(quote: string): RegExp | null {
  const w = words(quote);
  return w.length ? new RegExp(w.join("\\s*"), "g") : null;
}

/**
 * Which occurrence of the quote the annotation is, counting from `from` (the start of the first block it touches) up
 * to its own `start` in the source: the same text can appear twice in a reply ("Boss_Lv20" in a table and in a list).
 */
export function occurrenceInSource(source: string, quote: string, from: number, start: number): number {
  const re = sourcePattern(quote);
  if (!re) return 0;
  const src = source.replace(/\r\n/g, "\n");
  re.lastIndex = from;
  let n = 0;
  for (let m = re.exec(src); m && m.index < start; m = re.exec(src)) {
    n++;
    if (m[0].length === 0) re.lastIndex++;
  }
  return n;
}

/** The `occurrence`-th match of the quote in rendered text (the last one when there are fewer), or null. */
export function findInRendered(text: string, quote: string, occurrence: number): { start: number; end: number } | null {
  const re = renderedPattern(quote);
  if (!re) return null;
  let found: { start: number; end: number } | null = null;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    found = { start: m.index, end: m.index + m[0].length };
    if (n++ === occurrence) break;
  }
  return found;
}
