import type { GitCommit } from "@amo-studio/protocol";

// The commit picker's search (S13-B), as pure functions: every word must appear in the commit's hash, author or
// subject (case does not matter); the hits are marked in what the row shows.

export const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

export function matchCommit(c: GitCommit, words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = `${c.sha}\n${c.author}\n${c.email}\n${c.subject}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const filterCommits = (commits: readonly GitCommit[], query: string): GitCommit[] => {
  const words = queryWords(query);
  return commits.filter((c) => matchCommit(c, words));
};

/** `text` split into runs, the ones that match one of `words` marked (overlapping hits merge). */
export function markWords(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = lower.indexOf(w); at >= 0 && w; at = lower.indexOf(w, at + 1)) hit.fill(true, at, at + w.length);
  }
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.hit === hit[i]) last.text += text[i];
    else runs.push({ text: text[i]!, hit: hit[i]! });
  }
  return runs;
}

export const shortSha = (sha: string) => sha.slice(0, 7);
