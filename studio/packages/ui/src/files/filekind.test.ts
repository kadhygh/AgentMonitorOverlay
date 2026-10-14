import { describe, expect, it } from "vitest";
import { fileKind } from "./filekind.js";

describe("file type icons", () => {
  it("knows languages, formats and special names, case aside", () => {
    expect(fileKind("Assets/Scripts/Player.cs")).toMatchObject({ badge: "C#" });
    expect(fileKind("README.MD")).toMatchObject({ badge: "MD" });
    expect(fileKind("tools/select-runtime.ps1")).toMatchObject({ badge: ">_" });
    expect(fileKind("runtime/PMTableWorkbook.dll")).toMatchObject({ badge: "01" });
    expect(fileKind("Anim/Hero.overrideController")).toMatchObject({ badge: "U" });
    expect(fileKind(".gitignore")).toMatchObject({ badge: "GI" });
    expect(fileKind("docker/Dockerfile")).toMatchObject({ badge: "DK" });
  });

  it("draws images, text and unknown files", () => {
    expect(fileKind("ui/icon.PNG")).toEqual({ shape: "image" });
    expect(fileKind("notes.txt")).toEqual({ shape: "text" });
    expect(fileKind("data.weird")).toEqual({ shape: "doc" });
    expect(fileKind("noext")).toEqual({ shape: "doc" });
  });
});
