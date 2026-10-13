import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@amo-studio/protocol";
import { ancestors, buildTree, clampWidth, fileOrder, parsePrefs, splitFolder, splitName, treeRows, type TreeRow } from "./filetree.js";

const file = (path: string): GitChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, binary: false });

const show = (rows: TreeRow[]) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? `${r.open ? "▾" : "▸"} ${r.folder.name} (${r.folder.count})` : r.name}`);

describe("review file tree", () => {
  const files = [
    file("README.md"),
    file("src/game/drop/table.lua"),
    file("src/game/drop/rate.lua"),
    file("src/ui/Main.tsx"),
    file("Assets/Scripts/Player/PlayerController.cs"),
    file("b.txt"),
  ];

  it("puts folders first, files by name, and compacts chains of lone folders", () => {
    const tree = buildTree(files);
    expect(show(treeRows(tree, new Set()))).toEqual([
      "▾ Assets/Scripts/Player (1)",
      "  PlayerController.cs",
      "▾ src (3)",
      "  ▾ game/drop (2)",
      "    rate.lua",
      "    table.lua",
      "  ▾ ui (1)",
      "    Main.tsx",
      "b.txt",
      "README.md",
    ]);
    expect(tree.count).toBe(6);
  });

  it("hides a folded folder's files; j / k still walk every file in tree order", () => {
    const tree = buildTree(files);
    // A compacted row folds by its deepest path.
    expect(show(treeRows(tree, new Set(["src/game/drop", "Assets/Scripts/Player"])))).toEqual([
      "▸ Assets/Scripts/Player (1)",
      "▾ src (3)",
      "  ▸ game/drop (2)",
      "  ▾ ui (1)",
      "    Main.tsx",
      "b.txt",
      "README.md",
    ]);
    expect(fileOrder(files, "tree").map((f) => f.path)).toEqual([
      "Assets/Scripts/Player/PlayerController.cs",
      "src/game/drop/rate.lua",
      "src/game/drop/table.lua",
      "src/ui/Main.tsx",
      "b.txt",
      "README.md",
    ]);
    // 平铺 keeps the folder grouping of stage 11: the project's own files first.
    expect(fileOrder(files, "flat").map((f) => f.path)[0]).toBe("README.md");
    expect(ancestors("src/game/drop/rate.lua")).toEqual(["src", "src/game", "src/game/drop"]);
    expect(ancestors("b.txt")).toEqual([]);
  });

  it("does not compact a folder that has files of its own", () => {
    const tree = buildTree([file("a/x.ts"), file("a/b/c/y.ts")]);
    expect(show(treeRows(tree, new Set()))).toEqual(["▾ a (2)", "  ▾ b/c (1)", "    y.ts", "  x.ts"]);
  });

  it("splits names for a middle ellipsis that keeps the extension", () => {
    expect(splitName("PlayerInventoryController.cs")).toEqual({ head: "PlayerInventoryCont", tail: "roller.cs" });
    expect(splitName("a.ts")).toEqual({ head: "a", tail: ".ts" });
    expect(splitName("Makefile")).toEqual({ head: "Makefi", tail: "le" });
    expect(splitName(".gitignore")).toEqual({ head: ".gitig", tail: "nore" });
    // Each split puts the whole name back together.
    for (const n of ["x", "a.b.c.d.json", "很长很长的中文文件名字.md", "noext_but_quite_long_name"]) {
      const { head, tail } = splitName(n);
      expect(head + tail).toBe(n);
    }
    expect(splitFolder("src/game/drop")).toEqual({ head: "src/game/", tail: "drop" });
    expect(splitFolder("src")).toEqual({ head: "", tail: "src" });
  });

  it("clamps the list width and reads remembered choices defensively", () => {
    expect(clampWidth(100)).toBe(180);
    expect(clampWidth(900)).toBe(600);
    expect(clampWidth(Number.NaN)).toBe(280);
    expect(parsePrefs(null)).toEqual({ listWidth: 280, layout: "tree", split: false, mode: "changes" });
    expect(parsePrefs("{bad json")).toEqual({ listWidth: 280, layout: "tree", split: false, mode: "changes" });
    expect(parsePrefs(JSON.stringify({ listWidth: 420, layout: "flat", split: true, mode: "full" }))).toEqual({ listWidth: 420, layout: "flat", split: true, mode: "full" });
    expect(parsePrefs(JSON.stringify({ listWidth: 5000, layout: "x", split: "yes" }))).toEqual({ listWidth: 600, layout: "tree", split: false, mode: "changes" });
  });
});
