import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { discard, emptyTrash, removeTree, TRASH } from "./remove.js";

let root = "";
afterEach(() => root && removeTempDir(root));

describe("removing the platform's folders (2026-11-03)", () => {
  it("removes a tree file by file; a junction inside goes itself, never what it points to", () => {
    root = mkdtempSync(join(tmpdir(), "amo-remove-"));
    const keep = join(root, "keep");
    mkdirSync(keep);
    writeFileSync(join(keep, "precious.txt"), "x");
    const tree = join(root, "tree");
    mkdirSync(join(tree, "a", "b"), { recursive: true });
    writeFileSync(join(tree, "a", "b", "f.txt"), "f");
    symlinkSync(keep, join(tree, "a", "current"), "junction");
    removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(keep, "precious.txt"))).toBe(true);
    // Not there: nothing to do.
    removeTree(tree);
  });

  it("discard frees the name at once (through apps\\.trash); emptyTrash removes what is left there", () => {
    root = mkdtempSync(join(tmpdir(), "amo-remove-"));
    const apps = join(root, "apps");
    mkdirSync(join(apps, "studio", "0.9.1", "resources"), { recursive: true });
    writeFileSync(join(apps, "studio", "0.9.1", "resources", "app.js"), "x");
    expect(discard(join(apps, "studio", "0.9.1"), apps)).toBe(true);
    expect(readdirSync(join(apps, "studio"))).toEqual([]);
    // Something left in .trash from before (held then) goes on a start.
    mkdirSync(join(apps, TRASH, "0.9.0-old", "x"), { recursive: true });
    writeFileSync(join(apps, TRASH, "0.9.0-old", "x", "y.dll"), "y");
    expect(emptyTrash(apps)).toBe(0);
    expect(existsSync(join(apps, TRASH))).toBe(false);
    expect(discard(join(apps, "nothing-here"), apps)).toBe(true);
  });
});
