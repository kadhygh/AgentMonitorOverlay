// Ctrl+F (S14-A): finding text in the lines a view draws. It searches the data (each row's text), not the page, so it
// also finds lines in chunks the browser has not drawn yet, and the view scrolls there.

export interface FindMatch {
  /** The row (index into the texts searched). */
  row: number;
  start: number;
  end: number;
}

/** Matches beyond this are not counted (a one-letter search in a large file). */
export const FIND_MAX = 5000;

/** Every match of `query` in `texts`, row by row, left to right; none for an empty query. */
export function findMatches(texts: readonly string[], query: string, caseSensitive = false): FindMatch[] {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const out: FindMatch[] = [];
  for (let row = 0; row < texts.length; row++) {
    const t = caseSensitive ? texts[row]! : texts[row]!.toLowerCase();
    let at = t.indexOf(q);
    while (at >= 0) {
      out.push({ row, start: at, end: at + q.length });
      if (out.length >= FIND_MAX) return out;
      at = t.indexOf(q, at + q.length);
    }
  }
  return out;
}

/** The match to show first: the first one at or after `fromRow` (wrapping to the top). */
export function firstFrom(matches: readonly FindMatch[], fromRow: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.row >= fromRow);
  return i >= 0 ? i : 0;
}

/** The next (dir 1) or previous (-1) match, wrapping around. */
export const stepMatch = (count: number, current: number, dir: 1 | -1): number => (count ? (current + dir + count) % count : -1);

/** "第 3 / 共 12 个", "无结果", or "5000+" when the count stopped. */
export function matchLabel(count: number, current: number): string {
  if (!count) return "无结果";
  return `第 ${current + 1} / 共 ${count >= FIND_MAX ? `${FIND_MAX}+` : count} 个`;
}
