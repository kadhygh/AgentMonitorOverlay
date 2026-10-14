import { useEffect, useState } from "react";
import type { GitFileDiff } from "@amo-studio/protocol";
import { highlightTexts, hurry } from "../lib/highlight-client.js";
import { languageForPath } from "../lib/highlight-core.js";
import { diffTokensAsync, type DiffTokens } from "./splitview.js";

// A diff's colours, worked out in the highlight worker once per diff and kept with it: the diff shows at once in
// plain text, the colours follow; a diff read ahead is coloured ahead too, so it opens coloured.

const done = new WeakMap<GitFileDiff, DiffTokens | null>();
const pending = new WeakMap<GitFileDiff, Promise<DiffTokens | null>>();

/** The diff's colours (null: none for this file). `urgent` puts it before the diffs read ahead. */
export function diffTokensFor(diff: GitFileDiff, urgent = false): Promise<DiffTokens | null> {
  if (done.has(diff)) return Promise.resolve(done.get(diff)!);
  const on = pending.get(diff);
  if (on) {
    if (urgent) hurry(diff);
    return on;
  }
  const lang = languageForPath(diff.path);
  if (!lang || diff.binary || diff.tooLarge) {
    done.set(diff, null);
    return Promise.resolve(null);
  }
  const p = diffTokensAsync(diff.lines, (texts) => highlightTexts(texts, lang, { urgent, key: diff })).then(
    (tokens) => {
      done.set(diff, tokens);
      pending.delete(diff);
      return tokens;
    },
    () => {
      pending.delete(diff);
      return null;
    },
  );
  pending.set(diff, p);
  return p;
}

/** The colours of the diff in front: null until they are ready (the view shows plain text meanwhile). */
export function useDiffTokens(diff: GitFileDiff | null): DiffTokens | null {
  const [, ready] = useState(0);
  useEffect(() => {
    if (!diff || done.has(diff)) return;
    let live = true;
    void diffTokensFor(diff, true).then(() => live && ready((n) => n + 1));
    return () => {
      live = false;
    };
  }, [diff]);
  return (diff && done.get(diff)) ?? null;
}
