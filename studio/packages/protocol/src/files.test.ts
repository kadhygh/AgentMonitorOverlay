import { describe, expect, it } from "vitest";
import { absolutePath, fuzzyMatch, highlightRuns } from "./files.js";

const rank = (query: string, paths: string[]) =>
  paths
    .map((p) => ({ p, m: fuzzyMatch(query, p) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.p);

describe("fuzzyMatch", () => {
  it("prefers the file name, then a substring, then a subsequence", () => {
    const paths = ["src/app/main.ts", "docs/maintenance.md", "src/legacy/old/main.ts", "packages/mail/index.ts"];
    // A whole name ("main.ts") beats a name that starts the same ("maintenance.md"); shorter paths first.
    expect(rank("main", paths).slice(0, 3)).toEqual(["src/app/main.ts", "src/legacy/old/main.ts", "docs/maintenance.md"]);
    // A subsequence across the path still matches.
    expect(rank("pmi", paths)).toContain("packages/mail/index.ts");
    expect(fuzzyMatch("zzz", "src/app/main.ts")).toBeNull();
  });

  it("needs every whitespace-separated term, and ignores case and slash direction", () => {
    expect(fuzzyMatch("app MAIN", "src/app/main.ts")).not.toBeNull();
    expect(fuzzyMatch("app nope", "src/app/main.ts")).toBeNull();
    expect(fuzzyMatch("src\\app", "src/app/main.ts")!.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("returns the matched indices for highlighting", () => {
    const m = fuzzyMatch("main", "src/app/main.ts")!;
    expect(m.indices).toEqual([8, 9, 10, 11]);
    expect(highlightRuns("src/app/main.ts", m.indices)).toEqual([
      { text: "src/app/", hit: false },
      { text: "main", hit: true },
      { text: ".ts", hit: false },
    ]);
    expect(fuzzyMatch("", "a.ts")).toEqual({ score: 0, indices: [] });
  });
});

describe("absolutePath", () => {
  it("joins with the root's own separator", () => {
    expect(absolutePath("C:\\work\\proj", "src/a.ts")).toBe("C:\\work\\proj\\src\\a.ts");
    expect(absolutePath("C:\\work\\proj\\", "a.ts")).toBe("C:\\work\\proj\\a.ts");
    expect(absolutePath("/home/me/proj", "src/a.ts")).toBe("/home/me/proj/src/a.ts");
  });
});
