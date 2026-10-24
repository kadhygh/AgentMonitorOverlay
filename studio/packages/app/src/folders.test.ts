import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { folderName, listFolders, localPath, makeFolder, renameFolder } from "./folders.js";

let root: string | undefined;
afterEach(() => {
  if (root) removeTempDir(root);
  root = undefined;
});
const temp = () => (root = mkdtempSync(join(tmpdir(), "amo-studio-test-folders-")));
const driveOf = (path: string) => `${path.slice(0, 2).toUpperCase()}\\`;

describe("localPath", () => {
  it("takes only this machine's disks, never a network path", () => {
    expect(localPath("g:/PROJECT/x/", ["G:\\"])).toBe("G:\\PROJECT\\x");
    expect(localPath("G:", ["G:\\"])).toBe("G:\\");
    expect(() => localPath("\\\\nas.dxx.cn\\工具", ["G:\\"])).toThrow(/网络路径/);
    expect(() => localPath("Y:\\x", ["G:\\"])).toThrow(/不是本机硬盘/);
    expect(() => localPath("PROJECT", ["G:\\"])).toThrow(/完整路径/);
  });
});

describe("folderName", () => {
  it("accepts what Windows accepts", () => {
    expect(folderName("  新项目 ")).toBe("新项目");
    for (const bad of ["", "a/b", "a:b", "x?", "end.", "CON", "nul.txt", ".."]) expect(() => folderName(bad)).toThrow();
  });
});

describe("listing, making and renaming", () => {
  it("lists folders only, as Explorer shows them: Latin first, numbers in order, Chinese by pinyin", async () => {
    const dir = temp();
    for (const n of ["b10", "游戏", "b2", "a", "工具"]) mkdirSync(join(dir, n));
    const drives = [driveOf(dir)];
    const listing = await listFolders(dir, drives);
    expect(listing.folders).toEqual(["a", "b2", "b10", "工具", "游戏"]);
    expect(listing.parent).toBe(join(dir, ".."));
  });

  it("makes a folder and renames it, refusing a name taken", async () => {
    const dir = temp();
    const drives = [driveOf(dir)];
    const made = await makeFolder(dir, "新建文件夹", drives);
    expect(existsSync(made)).toBe(true);
    await expect(makeFolder(dir, "新建文件夹", drives)).rejects.toThrow();
    mkdirSync(join(dir, "taken"));
    await expect(renameFolder(made, "taken", drives)).rejects.toThrow(/同名/);
    const renamed = await renameFolder(made, "Game", drives);
    expect(renamed).toBe(join(dir, "Game"));
    expect(await renameFolder(renamed, "game", drives)).toBe(join(dir, "game"));
    expect((await listFolders(dir, drives)).folders).toEqual(["game", "taken"]);
  });
});
