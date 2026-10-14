import { describe, expect, it } from "vitest";
import { viewerHash, ViewerSet } from "./viewer-rules.js";

describe("viewerHash", () => {
  it("carries the file, its project, the lines, the mode and a nonce", () => {
    const h = viewerHash({ path: "G:\\game\\src\\Drop.cs", workspaceId: "ws-1", line: 12, endLine: 20, mode: "changes" }, 3)!;
    const q = new URLSearchParams(h.slice("#viewer?".length));
    expect(h.startsWith("#viewer?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ path: "G:\\game\\src\\Drop.cs", workspace: "ws-1", line: "12", end: "20", mode: "changes", n: "3" });
  });

  it("drops what is not valid, and refuses a missing path", () => {
    const q = new URLSearchParams(viewerHash({ path: "a.md", workspaceId: "bad id!", line: 0, endLine: 5, mode: "x" }, 1)!.slice(8));
    expect(Object.fromEntries(q)).toEqual({ path: "a.md", n: "1" });
    expect(new URLSearchParams(viewerHash({ path: "a.md", line: 9, endLine: 4 }, 1)!.slice(8)).get("end")).toBeNull();
    for (const bad of [null, {}, { path: "" }, { path: 3 }, { path: "a\nb" }, { path: "x".repeat(1001) }]) expect(viewerHash(bad, 1)).toBeNull();
  });
});

describe("ViewerSet", () => {
  it("reuses one preview window until it is pinned", () => {
    const set = new ViewerSet<string>();
    expect(set.target()).toBeNull();
    set.created("a");
    expect(set.target()).toBe("a");
    expect(set.pin("a")).toBe(true);
    expect(set.isPinned("a")).toBe(true);
    // The next open makes a new preview; the pinned one stays.
    expect(set.target()).toBeNull();
    set.created("b");
    expect(set.target()).toBe("b");
    expect(set.all()).toEqual(["b", "a"]);
  });

  it("forgets closed windows and refuses to pin a stranger", () => {
    const set = new ViewerSet<string>();
    set.created("a");
    set.closed("a");
    expect(set.target()).toBeNull();
    expect(set.pin("z")).toBe(false);
    set.created("b");
    set.pin("b");
    expect(set.pin("b")).toBe(true); // pinning again is harmless
    set.closed("b");
    expect(set.isPinned("b")).toBe(false);
    expect(set.all()).toEqual([]);
  });
});
