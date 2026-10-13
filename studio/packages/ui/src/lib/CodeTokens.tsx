import type { ReactNode } from "react";
import type { CodeToken } from "./highlight.js";

/** One line of code: its coloured tokens (from highlightLines), or the plain text while there are none. */
export function CodeTokens({ tokens, text }: { tokens: readonly CodeToken[] | null | undefined; text: string }): ReactNode {
  if (!tokens) return text;
  return tokens.map((t, i) =>
    t.color || t.italic || t.bold ? (
      <span key={i} style={{ color: t.color, fontStyle: t.italic ? "italic" : undefined, fontWeight: t.bold ? 600 : undefined }}>
        {t.text}
      </span>
    ) : (
      t.text
    ),
  );
}
