import { ensureLanguage, highlightLines, type CodeToken } from "./highlight-core.js";

// The highlight worker: colours whole texts away from the window, so a long file never stalls scrolling or typing.
// One message per job (see highlight-client.ts); grammars load here the first time they are needed.

export interface HighlightJob {
  id: number;
  lang: string;
  texts: string[];
}

export interface HighlightDone {
  id: number;
  tokens: (CodeToken[][] | null)[];
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<HighlightJob>) => void) | null; postMessage(message: HighlightDone): void };

scope.onmessage = (e) => {
  const { id, lang, texts } = e.data;
  void ensureLanguage(lang).then((ok) => scope.postMessage({ id, tokens: texts.map((t) => (ok ? highlightLines(t, lang) : null)) }));
};
