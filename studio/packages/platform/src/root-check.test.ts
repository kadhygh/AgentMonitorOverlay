import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { driveKind, rootDrive, rootWritable } from "./root-check.js";

// Whether the platform's folder can hold the tools (root-check.ts): a file made and removed; network and removable
// drives told apart (they work, with a warning).

let root = "";
afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});

describe("the platform's folder", () => {
  it("writable: a probe file made and removed again, nothing left; a folder that cannot be made is not writable", () => {
    root = mkdtempSync(join(tmpdir(), "amo-root-"));
    expect(rootWritable(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, "a-file"), "");
    expect(rootWritable(join(root, "a-file", "inside"))).toBe(false);
  });

  it("UNC paths are network shares; a drive letter is what Windows says of it", () => {
    expect(driveKind("\\\\nas\\share\\AMO Platform", null)).toBe("network");
    expect(driveKind("\\\\?\\UNC\\nas\\share\\AMO Platform", null)).toBe("network");
    expect(driveKind("Z:\\AMO Platform", "Network")).toBe("network");
    expect(driveKind("E:\\AMO Platform", "Removable")).toBe("removable");
    expect(driveKind("D:\\TOOLS\\AMO Platform", "Fixed")).toBe("local");
    expect(driveKind("\\\\?\\D:\\TOOLS", "Fixed")).toBe("local");
    expect(driveKind("D:\\TOOLS", null)).toBe("unknown");
    expect(driveKind("D:\\TOOLS", "NoRootDirectory")).toBe("unknown");
    // fsutil fsinfo drivetype's lines, English or Chinese.
    expect(driveKind("G:\\AMO", "G: - Fixed Drive")).toBe("local");
    expect(driveKind("Z:\\AMO", "Z: - Remote/Network Drive")).toBe("network");
    expect(driveKind("E:\\AMO", "E: - Removable Drive")).toBe("removable");
    expect(driveKind("Z:\\AMO", "Z: - 远程/网络驱动器")).toBe("network");
    expect(driveKind("E:\\AMO", "E: - 可移动驱动器")).toBe("removable");
    expect(driveKind("D:\\AMO", "D: - 固定驱动器")).toBe("local");
  });

  it("asks Windows: the temp folder is on a local disk", async () => {
    expect(await rootDrive(tmpdir())).toBe("local");
  });
});
