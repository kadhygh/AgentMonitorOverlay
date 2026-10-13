import { describe, expect, it } from "vitest";
import { classifyCommand, countDiff, unwrapShell, fileDiff, shortPath, tail, textDiff } from "./items.js";

describe("classifyCommand", () => {
  it("recognises simple reads, searches and listings", () => {
    expect(classifyCommand("cat importer.py")).toEqual({ kind: "read", target: "importer.py" });
    expect(classifyCommand("Get-Content -Raw src/a.ts")).toEqual({ kind: "read", target: "src/a.ts" });
    expect(classifyCommand("sed -n '1,80p' src/a.ts")).toEqual({ kind: "read", target: "src/a.ts" });
    expect(classifyCommand('rg -n "retry" src')).toEqual({ kind: "search", target: "retry · src" });
    expect(classifyCommand("findstr /s fetch *.py")).toEqual({ kind: "search", target: "fetch · *.py" });
    expect(classifyCommand("ls")).toEqual({ kind: "list", target: "." });
    expect(classifyCommand("dir src")).toEqual({ kind: "list", target: "src" });
  });

  it("looks inside cmd /c and powershell -Command wrappers", () => {
    expect(classifyCommand("cmd /c type README.md")).toEqual({ kind: "read", target: "README.md" });
    expect(classifyCommand("pwsh -Command 'Get-ChildItem docs'")).toEqual({ kind: "list", target: "docs" });
  });

  it("unwraps the shell Codex reports, absolute and quoted", () => {
    expect(unwrapShell(String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Set-Content x.txt ok'`)).toBe("Set-Content x.txt ok");
    expect(unwrapShell(String.raw`"C:\Windows\system32\cmd.exe" /c 'type a.txt'`)).toBe("type a.txt");
    expect(unwrapShell("npm test")).toBe("npm test");
  });

  it("leaves everything else a plain command", () => {
    expect(classifyCommand("npm test")).toBeNull();
    expect(classifyCommand("cat a.txt | grep x")).toBeNull();
    expect(classifyCommand("type a.txt > b.txt")).toBeNull();
    expect(classifyCommand("cat")).toBeNull();
    expect(classifyCommand("cmd /c echo 3 passed")).toBeNull();
  });
});

describe("diffs", () => {
  it("counts added and removed lines, not headers", () => {
    expect(countDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same")).toEqual({ added: 2, removed: 1 });
  });

  it("builds a diff for whole-text replacements", () => {
    expect(textDiff("a\nb", "c")).toBe("-a\n-b\n+c");
    expect(textDiff("", "x")).toBe("+x");
    expect(fileDiff("x.ts", "update", textDiff("a", "b"))).toEqual({ path: "x.ts", change: "update", added: 1, removed: 1, diff: "-a\n+b" });
    expect(fileDiff("x.ts", "add", undefined)).toEqual({ path: "x.ts", change: "add", added: 0, removed: 0 });
  });
});

describe("paths and output", () => {
  it("shows paths inside the workspace relative to it", () => {
    expect(shortPath("C:\\work\\proj\\src\\a.ts", "C:\\work\\proj")).toBe("src/a.ts");
    expect(shortPath("c:/Work/Proj/a.ts", "C:\\work\\proj\\")).toBe("a.ts");
    expect(shortPath("D:\\other\\a.ts", "C:\\work\\proj")).toBe("D:\\other\\a.ts");
  });

  it("keeps the tail of long output", () => {
    expect(tail("abcdef", 3)).toBe("…\ndef");
    expect(tail("abc", 3)).toBe("abc");
  });
});
