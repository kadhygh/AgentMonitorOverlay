import { describe, expect, it } from "vitest";
import { highlightLines, languageForFence, languageForPath } from "./highlight.js";

describe("highlight", () => {
  it("picks grammars by path and fence", () => {
    expect(languageForPath("Assets/Scripts/Player.cs")).toBe("csharp");
    expect(languageForPath("C:\game\Shaders\Water.shader")).toBe("shaderlab");
    expect(languageForPath("ProjectSettings/TagManager.asset")).toBe("yaml");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("notes")).toBeNull();
    expect(languageForFence("cs")).toBe("csharp");
    expect(languageForFence("C#")).toBe("csharp");
    expect(languageForFence("text")).toBeNull();
    expect(languageForFence("lua")).toBe("lua");
  });

  it("colours C# right away, comments across lines included", () => {
    const lines = highlightLines("/* a\n b */\npublic class Player { int hp = 3; }", "csharp")!;
    expect(lines).toHaveLength(3);
    expect(lines[1]!.map((t) => t.text).join("")).toBe(" b */");
    expect(lines[1]![0]!.color).toContain("--shiki-token-comment");
    const kw = lines[2]!.find((t) => t.text === "class");
    expect(kw?.color).toContain("--shiki-token-keyword");
  });

  it("returns null while a lazy grammar loads, and for no grammar", () => {
    expect(highlightLines("local x = 1", "lua")).toBeNull();
    expect(highlightLines("plain", null)).toBeNull();
  });

  it("leaves very long lines plain", () => {
    const long = `var s = "${"x".repeat(1200)}";`;
    const lines = highlightLines(`int a = 1;\n${long}`, "csharp")!;
    expect(lines[1]).toEqual([{ text: long }]);
  });
});
