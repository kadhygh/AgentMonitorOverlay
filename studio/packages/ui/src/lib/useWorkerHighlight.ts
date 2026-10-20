import { useEffect, useMemo, useState } from "react";
import type { CodeToken } from "./highlight-core.js";
import { highlightTexts } from "./highlight-client.js";

// Colours for code shown in the window, worked out in the highlight worker (2026-10-20): a code block in a reply, the
// quick look's file and change. They were coloured on the window's thread, without a limit, and a code block again on
// every streamed token. Now: after the text has rested `delayMs`, in the worker; past the limits, plain.

/** Longer texts stay plain. */
export const WORKER_HIGHLIGHT_MAX = { lines: 5000, chars: 400_000 };

/**
 * Each line's tokens, or null for a line not coloured (yet). While the text changes (a reply streaming), lines that
 * are as they were keep their colours; changed and new lines are plain until the text rests.
 */
export function useWorkerHighlight(text: string, lang: string | null, delayMs = 250): ReadonlyArray<readonly CodeToken[] | null> | null {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n"), [text]);
  const [done, setDone] = useState<{ lang: string; tokens: CodeToken[][] } | null>(null);
  const tooLong = text.length > WORKER_HIGHLIGHT_MAX.chars || lines.length > WORKER_HIGHLIGHT_MAX.lines;
  useEffect(() => {
    if (!lang || tooLong) return;
    let live = true;
    const t = setTimeout(() => {
      void highlightTexts([lines.join("\n")], lang).then(([tokens]) => {
        if (live && tokens) setDone({ lang, tokens });
      });
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lines, lang, tooLong, delayMs]);
  return useMemo(() => {
    if (!done || done.lang !== lang || tooLong) return null;
    // A line's tokens hold its text: they are used only while they spell the line as it is now.
    return lines.map((line, i) => {
      const tokens = done.tokens[i];
      return tokens && tokens.map((t) => t.text).join("") === line ? tokens : null;
    });
  }, [done, lines, lang, tooLong]);
}
