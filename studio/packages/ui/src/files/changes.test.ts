import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { diffRows, turnChanges } from "./changes.js";

const base = { sessionId: "s", createdAt: "2026-10-14T00:00:00Z" };
let seq = 0;
const tool = (fields: Partial<Extract<SessionItem, { type: "tool" }>>): SessionItem => ({
  ...base,
  id: `i${++seq}`,
  seq,
  type: "tool",
  name: "edit",
  kind: "edit",
  summary: "",
  status: "completed",
  ...fields,
});

describe("turnChanges", () => {
  it("joins a file's edits, sums the counts and keeps the first-touched order", () => {
    const items: SessionItem[] = [
      tool({ kind: "read", name: "read", summary: "a.ts" }),
      tool({ files: [{ path: "src/a.ts", change: "update", added: 2, removed: 1, diff: "@@ -1 +1,2 @@\n-x\n+y\n+z" }] }),
      tool({ files: [{ path: "b.md", change: "add", added: 3, removed: 0, diff: "+1\n+2\n+3" }] }),
      tool({ files: [{ path: "src\\a.ts", change: "update", added: 1, removed: 0, diff: "@@ -5 +6 @@\n+w" }] }),
      tool({ status: "declined", files: [{ path: "c.ts", change: "update", added: 9, removed: 9 }] }),
      tool({ files: [{ path: "b.md", change: "delete", added: 0, removed: 3 }] }),
    ];
    const files = turnChanges(items);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "b.md"]);
    expect(files[0]).toMatchObject({ added: 3, removed: 1, edits: 2, change: "update" });
    expect(files[0]!.diff).toBe("@@ -1 +1,2 @@\n-x\n+y\n+z\n@@ -5 +6 @@\n+w");
    expect(files[1]).toMatchObject({ change: "delete", edits: 2, added: 3, removed: 3 });
  });

  it("a file made in the turn stays new however often it is edited", () => {
    const files = turnChanges([
      tool({ name: "write", files: [{ path: "n.ts", change: "add", added: 1, removed: 0, diff: "+a" }] }),
      tool({ files: [{ path: "n.ts", change: "update", added: 1, removed: 1, diff: "-a\n+b" }] }),
    ]);
    expect(files[0]!.change).toBe("add");
  });
});

describe("diffRows", () => {
  it("numbers the new file's lines from hunk headers", () => {
    const rows = diffRows({ change: "update", diff: "--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file" });
    expect(rows.map((r) => [r.kind, r.text, r.newLine])).toEqual([
      ["hunk", "@@ -1,3 +1,4 @@", undefined],
      ["ctx", "a", 1],
      ["del", "b", undefined],
      ["add", "c", 2],
      ["add", "d", 3],
      ["ctx", "e", 4],
    ]);
  });

  it("has no numbers without hunk headers, and shows a new file's text as added", () => {
    expect(diffRows({ change: "update", diff: "-old\n+new" }).map((r) => r.newLine)).toEqual([undefined, undefined]);
    expect(diffRows({ change: "add", diff: "one\ntwo\n" })).toEqual([
      { kind: "add", text: "one", newLine: 1 },
      { kind: "add", text: "two", newLine: 2 },
    ]);
    expect(diffRows({ change: "update" })).toEqual([]);
  });
});
