// A project's files, for the file selector and the "@ 文件" suggestions (stage 11): the Host lists them (git ls-files,
// or a bounded walk), both sides match a query with the same fuzzy rule so the UI can highlight what matched.

/** One file of a project. `path` is relative to the project, with forward slashes. */
export interface ProjectFile {
  path: string;
  /** Bytes; null when the file could not be read (e.g. deleted since it was listed). */
  size: number | null;
  modifiedAt: string | null;
  /** Indices in `path` that the query matched (only when there was a query). */
  match?: number[];
  /** Recent changes only: git's short status (M, A, D, R, ??), or "" when the list comes from modification times. */
  change?: string;
}

export interface ProjectFiles {
  /** The project folder; join with `absolutePath`. */
  root: string;
  files: ProjectFile[];
  /** Files that matched before the list was cut to the limit. */
  total: number;
  /** `walk`: not a git repository, so a bounded walk that skips build output; it may have stopped early. */
  source: "git" | "walk";
  /** The walk hit its bound: some files are missing from the index. */
  partial: boolean;
}

/** The absolute path of a project file, with the root's own separator. */
export function absolutePath(root: string, relative: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${relative.replaceAll("/", sep)}`;
}

export interface FuzzyMatch {
  score: number;
  /** Matched indices in the target. */
  indices: number[];
}

const isBoundary = (s: string, i: number) => i === 0 || "/\\._- ".includes(s[i - 1]!) || (s[i - 1]! === s[i - 1]!.toLowerCase() && s[i]! !== s[i]!.toLowerCase());

/** The first subsequence of `q` in `t` (both lowercase) from `from`; null when it does not fit. */
function subsequence(q: string, t: string, from: number): number[] | null {
  const out: number[] = [];
  let at = from;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found < 0) return null;
    out.push(found);
    at = found + 1;
  }
  return out;
}

/**
 * Matches a query against a path, Everything-like: whitespace separates terms that must all match; a term matches as
 * a substring (best: in the file name) or as a subsequence. Higher scores are better; null means no match.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const terms = query.toLowerCase().replaceAll("\\", "/").split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, indices: [] };
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf("/") + 1;
  let score = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    let best: FuzzyMatch | null = null;
    const consider = (s: number, idx: number[]) => {
      if (!best || s > best.score) best = { score: s, indices: idx };
    };
    const inName = lower.indexOf(term, nameStart);
    if (inName >= 0) consider(1000 - (inName - nameStart) * 2 + (inName === nameStart ? 100 : 0) + (".".includes(lower[inName + term.length] ?? ".") ? 80 : 0), range(inName, term.length));
    const anywhere = lower.indexOf(term);
    if (anywhere >= 0) consider(700 - anywhere + (isBoundary(path, anywhere) ? 50 : 0), range(anywhere, term.length));
    const sub = subsequence(term, lower, nameStart) ?? subsequence(term, lower, 0);
    if (sub) {
      let s = sub[0]! >= nameStart ? 400 : 200;
      for (let k = 0; k < sub.length; k++) {
        if (k > 0 && sub[k] === sub[k - 1]! + 1) s += 15;
        if (isBoundary(path, sub[k]!)) s += 10;
      }
      consider(s - (sub.at(-1)! - sub[0]!), sub);
    }
    if (!best) return null;
    const b: FuzzyMatch = best;
    score += b.score;
    for (const i of b.indices) indices.add(i);
  }
  // Shorter paths win ties: "src/app.ts" before "src/legacy/old/app.ts".
  return { score: score - path.length * 0.5, indices: [...indices].sort((a, b) => a - b) };
}

const range = (start: number, length: number) => Array.from({ length }, (_, k) => start + k);

/** Splits a path into plain and matched runs, for highlighting. */
export function highlightRuns(path: string, indices: readonly number[]): Array<{ text: string; hit: boolean }> {
  const hits = new Set(indices);
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < path.length; i++) {
    const hit = hits.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += path[i];
    else runs.push({ text: path[i]!, hit });
  }
  return runs;
}
