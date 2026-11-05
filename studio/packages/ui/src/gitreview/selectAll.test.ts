import { describe, expect, it } from "vitest";
import type { GitFileDiff } from "@amo-studio/protocol";
import { diffRows } from "./logic.js";
import { diffText, fileText, isSelectAllKey, typingIn } from "./selectAll.js";

// Ctrl+A in a file's view (2026-11-05): what Ctrl+C copies once all is selected, and which presses are the view's.

const diff: GitFileDiff = {
  range: "working",
  path: "drop.lua",
  binary: false,
  tooLarge: false,
  lines: [
    { kind: "del", oldLine: 1, newLine: null, text: "local rate = 0.1" },
    { kind: "add", oldLine: null, newLine: 1, text: "local rate = 0.25" },
    { kind: "context", oldLine: 2, newLine: 2, text: "return rate" },
  ],
  hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, start: 0, end: 3 }],
};

describe("select all", () => {
  it("copies a diff as a unified diff's body: the @@ line, then each line marked, no line numbers", () => {
    expect(diffText(diffRows(diff, "changes"))).toBe(["@@ -1,2 +1,2 @@", "-local rate = 0.1", "+local rate = 0.25", " return rate"].join("\n"));
  });

  it("copies a file with its line endings as \\n", () => {
    expect(fileText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("takes Ctrl+A (either case, or ⌘A) but not with Shift or Alt", () => {
    const key = (init: KeyboardEventInit) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "a", ...init }) as KeyboardEvent;
    expect(isSelectAllKey(key({ ctrlKey: true }))).toBe(true);
    expect(isSelectAllKey(key({ ctrlKey: true, key: "A" }))).toBe(true);
    expect(isSelectAllKey(key({ metaKey: true }))).toBe(true);
    expect(isSelectAllKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAllKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSelectAllKey(key({}))).toBe(false);
  });

  it("leaves Ctrl+A to a box being typed in", () => {
    const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) }) as unknown as EventTarget;
    expect(typingIn(inside("textarea"))).toBe(true);
    expect(typingIn(inside("input"))).toBe(true);
    expect(typingIn({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
