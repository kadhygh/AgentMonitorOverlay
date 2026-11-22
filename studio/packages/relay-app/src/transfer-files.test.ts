import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freeName, TransferFiles } from "./transfer-files.js";

// 传文件 on this computer (2026-11-23): what is picked is listed and stays readable for its send; what is received goes
// into the folder accepted into, under free names, through checked .part files.

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function setup() {
  root = mkdtempSync(join(tmpdir(), "amo-relay-tf-"));
  const src = join(root, "src");
  mkdirSync(join(src, "素材", "ui"), { recursive: true });
  mkdirSync(join(src, "素材", "空"), { recursive: true });
  writeFileSync(join(src, "素材", "ui", "a.png"), "png!");
  writeFileSync(join(src, "素材", "说明.txt"), "hello");
  writeFileSync(join(src, "readme.md"), "# hi");
  mkdirSync(join(src, "other"), { recursive: true });
  writeFileSync(join(src, "other", "readme.md"), "another");
  return { files: new TransferFiles(join(root, "home")), src, inbox: join(root, "inbox") };
}

describe("传文件 on this computer (2026-11-23)", () => {
  it("lists what is picked (folders inside out, empty ones too), leaves out a second thing of the same name, reads only that", async () => {
    const { files, src } = setup();
    const first = await files.pick([join(src, "素材")]);
    const both = await files.pick([join(src, "readme.md"), join(src, "other", "readme.md"), join(src, "nothere.txt")], first.pick);
    expect(both.pick).toBe(first.pick);
    expect(both.roots).toEqual([
      { name: "素材", folder: true },
      { name: "readme.md", folder: false },
    ]);
    expect(both.entries).toEqual([
      { path: "素材/ui/a.png", size: 4 },
      { path: "素材/说明.txt", size: 5 },
      { path: "readme.md", size: 4 },
    ]);
    expect(both.dirs).toEqual(["素材/空"]);
    expect(both.totalSize).toBe(13);
    expect(both.skipped).toEqual(["readme.md（和已选的重名）", "nothere.txt（读不到）"]);

    files.bind(both.pick, "x_0123456789abcdef", ["素材"]);
    expect(Buffer.from(await files.readPiece("x_0123456789abcdef", "素材/说明.txt", 1, 3)).toString()).toBe("ell");
    expect(Buffer.from(await files.readPiece("x_0123456789abcdef", "素材/说明.txt", 3, 100)).toString()).toBe("lo");
    expect(await files.sourceHash("x_0123456789abcdef", "素材/ui/a.png")).toEqual({ sha256: sha("png!"), size: 4 });
    // Only what was kept, and nothing outside it.
    await expect(files.readPiece("x_0123456789abcdef", "readme.md", 0, 4)).rejects.toThrow(/不在这次发送里/);
    await expect(files.readPiece("x_0123456789abcdef", "素材/../readme.md", 0, 4)).rejects.toThrow(/路径不对/);
    await expect(files.readPiece("x_nothere", "素材/说明.txt", 0, 4)).rejects.toThrow(/没有这次发送/);
  });

  it("receives into free names, piece by piece, checks each file and goes on after a break", async () => {
    const { files, inbox } = setup();
    mkdirSync(join(inbox, "素材"), { recursive: true });
    writeFileSync(join(inbox, "readme.md"), "mine");
    const id = "x_00000000000000aa";
    const state = files.prepare(id, inbox, { roots: ["素材", "readme.md"], folders: ["素材"], dirs: ["素材/空"] });
    expect(state.names).toEqual({ 素材: "素材 (1)" });
    expect(existsSync(join(inbox, "素材 (1)", "空"))).toBe(true);
    // Asked again (after a restart): the same.
    expect(files.prepare(id, join(inbox, "elsewhere"), { roots: ["素材"], folders: ["素材"], dirs: [] }).names).toEqual({ 素材: "素材 (1)" });

    const body = Buffer.from("0123456789");
    expect(files.partSize(id, "素材/ui/a.png")).toBe(0);
    await files.writePiece(id, "素材/ui/a.png", 0, body.subarray(0, 4));
    expect(files.partSize(id, "素材/ui/a.png")).toBe(4);
    await expect(files.writePiece(id, "素材/ui/a.png", 8, body.subarray(8))).rejects.toThrow(/位置对不上/);
    await files.writePiece(id, "素材/ui/a.png", 4, body.subarray(4));
    expect(readdirSync(join(inbox, "素材 (1)", "ui"))).toEqual([`a.png.${id.slice(-6)}.part`]);
    expect(await files.finish(id, "素材/ui/a.png", "0".repeat(64))).toBe(false);
    expect(files.partSize(id, "素材/ui/a.png")).toBe(0);
    await files.writePiece(id, "素材/ui/a.png", 0, body);
    expect(await files.finish(id, "素材/ui/a.png", sha(body))).toBe(join(inbox, "素材 (1)", "ui", "a.png"));
    expect(files.partSize(id, "素材/ui/a.png")).toBe(-1);

    // A top-level file is named when it is saved; an empty one needs no piece.
    await files.writePiece(id, "readme.md", 0, Buffer.from("# hi"));
    expect(await files.finish(id, "readme.md", sha("# hi"))).toBe(join(inbox, "readme (1).md"));
    expect(readFileSync(join(inbox, "readme.md"), "utf8")).toBe("mine");
    expect(await files.finish(id, "素材/空.txt", sha(""))).toBe(join(inbox, "素材 (1)", "空.txt"));
    expect(files.received(id)).toEqual({ dir: inbox, names: { 素材: "素材 (1)", "readme.md": "readme (1).md" }, done: ["素材/ui/a.png", "readme.md", "素材/空.txt"] });
    expect(files.shown(id)).toEqual({ item: null, dir: inbox });
    await expect(files.writePiece(id, "../evil.txt", 0, body)).rejects.toThrow(/路径不对/);
  });

  it("drops the parts of a send that ended early, keeps what was saved", async () => {
    const { files, inbox } = setup();
    const id = "x_00000000000000bb";
    files.prepare(id, inbox, { roots: ["素材", "b.bin"], folders: ["素材"], dirs: [] });
    await files.writePiece(id, "素材/a.txt", 0, Buffer.from("aa"));
    expect(await files.finish(id, "素材/a.txt", sha("aa"))).toBeTruthy();
    await files.writePiece(id, "素材/deep/c.txt", 0, Buffer.from("c"));
    await files.writePiece(id, "b.bin", 0, Buffer.from("b"));
    files.discard(id);
    expect(readdirSync(inbox)).toEqual(["素材"]);
    expect(readdirSync(join(inbox, "素材"))).toEqual(["a.txt", "deep"]);
    expect(readdirSync(join(inbox, "素材", "deep"))).toEqual([]);
    expect(files.received(id)).toBeNull();
  });

  it("free names", () => {
    const { inbox } = setup();
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "a.txt"), "");
    writeFileSync(join(inbox, "a (1).txt"), "");
    expect(freeName(inbox, "a.txt", false)).toBe("a (2).txt");
    expect(freeName(inbox, "a.txt", true)).toBe("a.txt (1)");
    expect(freeName(inbox, "b", false)).toBe("b");
    expect(freeName(inbox, "a.tar.gz", false, (c) => c === "a.tar.gz")).toBe("a.tar (1).gz");
  });
});
