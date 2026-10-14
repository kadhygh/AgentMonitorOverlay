import { useSyncExternalStore } from "react";
import { grammarLoads, onGrammarLoad } from "./highlight-core.js";

// The highlighter for React views: highlight-core.ts plus a hook that re-renders when a grammar arrives. Long texts
// go through highlight-client.ts instead, which colours them in a worker.

export * from "./highlight-core.js";

/** Re-renders the caller when a grammar finishes loading (so a plain first render gets its colours). */
export function useGrammarLoads(): number {
  return useSyncExternalStore(onGrammarLoad, grammarLoads);
}

