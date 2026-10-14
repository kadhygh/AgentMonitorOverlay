import { describe, expect, it } from "vitest";
import { fileName, folderOf, looksLikeFilePath, parseInlinePath, parseLinkTarget, shortFolder, splitLine } from "./paths.js";

describe("parseInlinePath", () => {
  it("reads paths with lines and columns", () => {
    expect(parseInlinePath("src/a.cs")).toEqual({ path: "src/a.cs" });
    expect(parseInlinePath("importer.py:4")).toEqual({ path: "importer.py", line: 4 });
    expect(parseInlinePath("src\\Player.cs:12:5")).toEqual({ path: "src\\Player.cs", line: 12, column: 5 });
    expect(parseInlinePath("a.ts:24-30")).toEqual({ path: "a.ts", line: 24, endLine: 30 });
    expect(parseInlinePath("a.ts:24–30")).toEqual({ path: "a.ts", line: 24, endLine: 30 });
    expect(parseInlinePath("a.ts:30-24")).toEqual({ path: "a.ts", line: 30 });
    expect(parseInlinePath("a.ts#L7-L9")).toEqual({ path: "a.ts", line: 7, endLine: 9 });
    expect(parseInlinePath("a.ts#L7")).toEqual({ path: "a.ts", line: 7 });
    expect(parseInlinePath("Foo.cs(12,3)")).toEqual({ path: "Foo.cs", line: 12, column: 3 });
    expect(parseInlinePath("G:\\PROJECT\\My Game\\Assets\\Player.cs:3")).toEqual({ path: "G:\\PROJECT\\My Game\\Assets\\Player.cs", line: 3 });
    expect(parseInlinePath("file:///G:/a%20b/c.md")).toEqual({ path: "G:/a b/c.md" });
    expect(parseInlinePath(" ./README.md ")).toEqual({ path: "./README.md" });
    expect(parseInlinePath(".gitignore")).toEqual({ path: ".gitignore" });
    expect(parseInlinePath("packages/app/bin/run")).toEqual({ path: "packages/app/bin/run" });
  });

  it("leaves out what is not a path", () => {
    for (const code of [
      "npm run verify",
      "fetch",
      "retries",
      "foo()",
      "obj.method(x)",
      "https://example.com/a.ts",
      "1.2.3",
      "v2.0",
      "src/",
      "*.ts",
      "a = b.c",
      "~/notes.md",
      "\\\\server\\share\\a.cs",
      "--flag",
      "<T>",
      "x".repeat(400),
      "a.b\nc.d",
      "",
    ])
      expect(parseInlinePath(code), code).toBeNull();
  });

  it("splits a trailing line only when something comes before it", () => {
    expect(splitLine(":12")).toEqual({ path: ":12" });
    expect(splitLine("a.ts:0")).toEqual({ path: "a.ts" });
  });

  it("judges shapes", () => {
    expect(looksLikeFilePath("package.json")).toBe(true);
    expect(looksLikeFilePath("Makefile")).toBe(false);
    expect(looksLikeFilePath("src/Makefile")).toBe(true);
    expect(looksLikeFilePath("C:\\Program Files (x86)\\a.exe")).toBe(false);
  });
});

describe("parseLinkTarget", () => {
  it("reads local destinations", () => {
    expect(parseLinkTarget("src/a.cs")).toEqual({ path: "src/a.cs" });
    expect(parseLinkTarget("src/a.cs#L12")).toEqual({ path: "src/a.cs", line: 12 });
    expect(parseLinkTarget("src/a.cs#L12-L20")).toEqual({ path: "src/a.cs", line: 12, endLine: 20 });
    expect(parseLinkTarget("src/a.cs#L12-20")).toEqual({ path: "src/a.cs", line: 12, endLine: 20 });
    expect(parseLinkTarget("src/a.cs:12-20")).toEqual({ path: "src/a.cs", line: 12, endLine: 20 });
    expect(parseLinkTarget("src/a.cs:12")).toEqual({ path: "src/a.cs", line: 12 });
    expect(parseLinkTarget("<docs/My Notes.md>")).toEqual({ path: "docs/My Notes.md" });
    expect(parseLinkTarget("docs/My%20Notes.md")).toEqual({ path: "docs/My Notes.md" });
    expect(parseLinkTarget("file:///G:/x/y.ts#L3")).toEqual({ path: "G:/x/y.ts", line: 3 });
    expect(parseLinkTarget("G:\\x\\y.ts")).toEqual({ path: "G:\\x\\y.ts" });
    // Codex writes absolute links with a slash before the drive.
    expect(parseLinkTarget("/G:/PROJECT/p/AGENTS.md")).toEqual({ path: "G:/PROJECT/p/AGENTS.md" });
    expect(parseLinkTarget("/G:/PROJECT/p/a.cs:12")).toEqual({ path: "G:/PROJECT/p/a.cs", line: 12 });
    expect(parseInlinePath("/G:/PROJECT/p/a.cs")).toEqual({ path: "G:/PROJECT/p/a.cs" });
  });

  it("refuses web links, anchors, queries and other schemes", () => {
    for (const href of ["https://example.com", "mailto:a@b.c", "#intro", "a.md#intro", "a.md?x=1", "//cdn/x.js", "a%E0.md", "vscode://file/x"])
      expect(parseLinkTarget(href), href).toBeNull();
  });
});

describe("names", () => {
  it("splits names and folders", () => {
    expect(fileName("G:\\a\\b.cs")).toBe("b.cs");
    expect(fileName("a/b/")).toBe("b");
    expect(folderOf("src/a/b.ts")).toBe("src/a");
    expect(folderOf("b.ts")).toBe("");
  });

  it("shortens long folders in the middle", () => {
    expect(shortFolder("G:\\p")).toBe("G:\\p");
    const s = shortFolder("G:\\PROJECT\\AgentMonitorOverlay-studio\\studio\\packages\\ui\\src", 32);
    expect(s.startsWith("G:\\PROJECT\\…\\")).toBe(true);
    expect(s.endsWith("src")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(32);
  });
});
