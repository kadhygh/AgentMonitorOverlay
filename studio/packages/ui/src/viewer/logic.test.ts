import { describe, expect, it } from "vitest";
import type { GitChangedFile, Workspace } from "@amo-studio/protocol";
import { findChangedFile, linesLabel, parseViewerHash, projectOf, relativeIn, viewerHash } from "./logic.js";

const ws = (id: string, path: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: id, path, createdAt: "", ...extra });
const changed = (path: string, extra: Partial<GitChangedFile> = {}): GitChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, binary: false, ...extra });

describe("the viewer's address", () => {
  it("round-trips a file, its project, a range, the mode and the nonce", () => {
    const t = { path: "G:\\game\\a b\\Drop.cs", workspaceId: "w1", line: 12, endLine: 20, mode: "changes" as const, nonce: "4" };
    expect(parseViewerHash(viewerHash(t))).toEqual(t);
    expect(parseViewerHash(viewerHash({ path: "README.md" }))).toEqual({ path: "README.md" });
  });

  it("drops a range that ends before it starts, and reads only #viewer with a path", () => {
    expect(parseViewerHash("#viewer?path=a.md&line=9&end=3")).toEqual({ path: "a.md", line: 9 });
    expect(parseViewerHash("#viewer?line=3")).toBeNull();
    expect(parseViewerHash("#review?workspace=w1")).toBeNull();
  });
});

describe("projects and paths", () => {
  const all = [ws("common", "G:\\common", { builtin: "common" }), ws("game", "G:\\game"), ws("tools", "G:\\game\\tools"), ws("web", "D:/web")];

  it("finds the innermost project holding an absolute path", () => {
    expect(projectOf("G:/game/src/a.cs", all)?.id).toBe("game");
    expect(projectOf("g:\\GAME\\tools\\x.py", all)?.id).toBe("tools");
    expect(projectOf("G:\\common\\note.md", all)).toBeNull();
    expect(projectOf("G:\\gamer\\a.cs", all)).toBeNull();
  });

  it("trusts the named project for relative paths and for paths inside it", () => {
    expect(projectOf("src/a.cs", all, "web")?.id).toBe("web");
    expect(projectOf("src/a.cs", all)).toBeNull();
    expect(projectOf("G:\\game\\tools\\x.py", all, "game")?.id).toBe("game");
    expect(projectOf("D:\\web\\i.ts", all, "game")?.id).toBe("web");
  });

  it("makes paths relative to a folder", () => {
    expect(relativeIn("G:\\Game\\src\\a.cs", "g:/game/")).toBe("src/a.cs");
    expect(relativeIn("G:\\game", "G:\\game")).toBeNull();
  });

  it("finds the changed file a Review is asked for", () => {
    const files = [changed("src/Drop.cs"), changed("docs/new.md", { oldPath: "docs/old.md", status: "renamed" })];
    expect(findChangedFile(files, "G:\\game\\SRC\\drop.cs", "G:\\game")?.path).toBe("src/Drop.cs");
    expect(findChangedFile(files, "./src/Drop.cs", "G:\\game")?.path).toBe("src/Drop.cs");
    expect(findChangedFile(files, "docs\\old.md", "G:\\game")?.path).toBe("docs/new.md");
    expect(findChangedFile(files, "G:\\game\\src\\Other.cs", "G:\\game")).toBeNull();
    expect(findChangedFile(files, "D:\\elsewhere\\src\\Drop.cs", "G:\\game")).toBeNull();
  });

  it("says which lines", () => {
    expect(linesLabel()).toBe("");
    expect(linesLabel(4)).toBe("第 4 行");
    expect(linesLabel(4, 9)).toBe("第 4–9 行");
  });
});
