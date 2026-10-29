import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_FILE_CHUNK, REMOTE_FILE_MAX_BYTES, remoteFileKind, type SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { attachedPaths, itemForPeer, readRemoteFile, resolveAsked, safeRel, type FileRoots } from "./files.js";

// 远程 step 3 on A (2026-10-29): what a paired device may fetch of a granted task — under its folder (links and junctions
// resolved first) or among the pictures of its conversations, HTML / Markdown / images by name and content, at most
// 20 MB, in pieces — and how the paths it gets name the task's folder instead of this computer's own.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDir(d);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function layout() {
  const top = mkdtempSync(join(tmpdir(), "amo-rfiles-"));
  dirs.push(top);
  const root = join(top, "proj");
  const outside = join(top, "secret");
  const attachments = join(top, "data", "attachments");
  for (const d of [join(root, "docs", "img"), outside, attachments]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# 标题\n\n正文");
  writeFileSync(join(root, "docs", "page.html"), "<html><body><img src=\"img/p.png\"></body></html>");
  writeFileSync(join(root, "docs", "img", "p.png"), PNG);
  writeFileSync(join(root, "docs", "fake.png"), "not a picture at all");
  writeFileSync(join(root, "docs", "bin.md"), Buffer.from([0x61, 0, 0x62]));
  writeFileSync(join(root, "tool.exe"), "MZ");
  writeFileSync(join(root, "docs", "run.ps1"), "Write-Host 你好");
  writeFileSync(join(root, "docs", "log.txt"), Buffer.from([0x61, 0, 0x62]));
  writeFileSync(join(outside, "keys.md"), "secret");
  writeFileSync(join(attachments, "att-1.png"), PNG);
  writeFileSync(join(attachments, "att-other.png"), PNG);
  const roots: FileRoots = { root, attachments, attached: () => [join(attachments, "att-1.png")] };
  return { top, root, outside, attachments, roots };
}

describe("remote files on A (step 3)", () => {
  it("names the kinds it takes by extension", () => {
    expect(remoteFileKind("a/b/Page.HTML")).toBe("html");
    expect(remoteFileKind("x.markdown")).toBe("markdown");
    expect(remoteFileKind("shot.webp")).toBe("image");
    expect(remoteFileKind("run.exe")).toBeNull();
    expect(remoteFileKind("Assets/x.PDF")).toBeNull();
    // Anything else is text to A (which looks at the content): scripts, configs, files without an extension.
    expect(remoteFileKind("README")).toBe("text");
    expect(remoteFileKind("src/Boxer.cs")).toBe("text");
    expect(remoteFileKind("tools/run.ts")).toBe("text");
  });

  it("resolves the task folder's name, a cwd, absolute paths and attachments", () => {
    const { root, attachments, roots } = layout();
    expect(resolveAsked(roots, "任务文件夹/docs/a.md")).toBe(join(root, "docs", "a.md"));
    expect(resolveAsked(roots, "docs\\a.md")).toBe(join(root, "docs", "a.md"));
    expect(resolveAsked(roots, "a.md", "任务文件夹\\docs")).toBe(join(root, "docs", "a.md"));
    expect(resolveAsked(roots, join(root, "docs", "a.md"))).toBe(join(root, "docs", "a.md"));
    expect(resolveAsked(roots, "附件/att-1.png")).toBe(join(attachments, "att-1.png"));
    expect(() => resolveAsked(roots, "  ")).toThrow("没有给出文件");
  });

  it("serves a file under the task folder, named by its place there", async () => {
    const { root, roots } = layout();
    const a = await readRemoteFile(roots, { taskId: "t", path: join(root, "docs", "a.md"), offset: 0 }, "A 台式机");
    expect(a).toMatchObject({ rel: "docs/a.md", kind: "markdown", size: Buffer.byteLength("# 标题\n\n正文"), offset: 0 });
    expect(Buffer.from(a.data!, "base64").toString()).toBe("# 标题\n\n正文");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A script a page links to: text.
    const ps = await readRemoteFile(roots, { taskId: "t", path: "docs/run.ps1", offset: 0 }, "A 台式机");
    expect(ps).toMatchObject({ rel: "docs/run.ps1", kind: "text" });
    expect(Buffer.from(ps.data!, "base64").toString()).toBe("Write-Host 你好");
    // The same file again with what B has: nothing sent.
    const again = await readRemoteFile(roots, { taskId: "t", path: "docs/a.md", offset: 0, have: { size: a.size, mtime: a.mtime, sha256: a.sha256! } }, "A");
    expect(again).toMatchObject({ unchanged: true, rel: "docs/a.md" });
    expect(again.data).toBeUndefined();
    // Touched but the same content: still unchanged (by sha256).
    utimesSync(join(root, "docs", "a.md"), new Date(), new Date(Date.now() + 5000));
    expect(await readRemoteFile(roots, { taskId: "t", path: "docs/a.md", offset: 0, have: { size: a.size, mtime: a.mtime, sha256: a.sha256! } }, "A")).toMatchObject({ unchanged: true });
    // An image the task's conversation sent: under 附件/.
    expect(await readRemoteFile(roots, { taskId: "t", path: "附件/att-1.png", offset: 0 }, "A")).toMatchObject({ rel: "附件/att-1.png", kind: "image" });
  });

  it("refuses what is outside the folder, escapes through a link, the wrong kind, odd content and big files, saying why", async () => {
    const { top, root, outside, attachments, roots } = layout();
    const ask = (path: string, cwd?: string) => readRemoteFile(roots, { taskId: "t", path, offset: 0, ...(cwd ? { cwd } : {}) }, "A 台式机");
    await expect(ask(join(outside, "keys.md"))).rejects.toThrow("不在任务的文件夹里");
    await expect(ask("../secret/keys.md")).rejects.toThrow("不在任务的文件夹里");
    await expect(ask("keys.md", outside)).rejects.toThrow("不在任务的文件夹里");
    // Another attachment than the task's own.
    await expect(ask(join(attachments, "att-other.png"))).rejects.toThrow("不在任务的文件夹里");
    // A junction (a directory link Windows makes without rights) inside the folder that points out of it.
    symlinkSync(outside, join(root, "docs", "out"), "junction");
    await expect(ask("docs/out/keys.md")).rejects.toThrow("不在任务的文件夹里");
    await expect(ask("tool.exe")).rejects.toThrow("不能看程序和二进制文件（这是 .exe 文件）");
    await expect(ask("docs/fake.png")).rejects.toThrow("内容不像 .png 图片");
    await expect(ask("docs/bin.md")).rejects.toThrow("不是文本");
    await expect(ask("docs/log.txt")).rejects.toThrow("是二进制文件，不是文本");
    await expect(ask("docs/nope.md")).rejects.toThrow("A 台式机 上找不到这个文件");
    await expect(ask("docs")).rejects.toThrow();
    writeFileSync(join(root, "big.png"), Buffer.concat([PNG, Buffer.alloc(REMOTE_FILE_MAX_BYTES)]));
    await expect(ask("big.png")).rejects.toThrow(/文件太大（20\.0 MB），远程最多 20\.0 MB/);
    // Text as the viewer shows it here: at most 2 MB.
    writeFileSync(join(root, "big.log"), "x".repeat(2 * 1024 * 1024 + 1));
    await expect(ask("big.log")).rejects.toThrow(/文件太大（2\.0 MB），远程看文本文件最多 2\.0 MB/);
    expect(top).toBeTruthy();
  });

  it("sends a big file in pieces and says when it changed midway", async () => {
    const { root, roots } = layout();
    const body = Buffer.concat([PNG, Buffer.alloc(REMOTE_FILE_CHUNK + 1000, 7)]);
    writeFileSync(join(root, "docs", "img", "big.png"), body);
    const first = await readRemoteFile(roots, { taskId: "t", path: "docs/img/big.png", offset: 0 }, "A");
    expect(Buffer.from(first.data!, "base64").length).toBe(REMOTE_FILE_CHUNK);
    const second = await readRemoteFile(roots, { taskId: "t", path: "docs/img/big.png", offset: REMOTE_FILE_CHUNK, expect: { size: first.size, mtime: first.mtime } }, "A");
    expect(Buffer.concat([Buffer.from(first.data!, "base64"), Buffer.from(second.data!, "base64")]).equals(body)).toBe(true);
    await expect(readRemoteFile(roots, { taskId: "t", path: "docs/img/big.png", offset: REMOTE_FILE_CHUNK, expect: { size: first.size, mtime: first.mtime - 1000 } }, "A")).rejects.toThrow("传的时候被改了");
  });

  it("names a command's working directory by the task folder; keeps B's copies inside its folder", () => {
    const root = join(tmpdir(), "proj-x");
    const tool = { id: "i", sessionId: "s", seq: 1, createdAt: "", type: "tool", name: "shell", summary: "ls", status: "completed", cwd: join(root, "src") } as SessionItem;
    expect((itemForPeer(tool, root) as { cwd?: string }).cwd).toBe("任务文件夹\\src");
    expect((itemForPeer({ ...tool, cwd: root } as SessionItem, root) as { cwd?: string }).cwd).toBe("任务文件夹");
    expect((itemForPeer({ ...tool, cwd: "D:\\elsewhere" } as SessionItem, root) as { cwd?: string }).cwd).toBe("D:\\elsewhere");
    expect(attachedPaths([{ ...tool, images: [{ id: null, path: "x.png" }] } as SessionItem, { id: "u", sessionId: "s", seq: 2, createdAt: "", type: "user", text: "", images: [{ id: "att-1", path: "y.png" }] } as SessionItem])).toEqual(["x.png", "y.png"]);
    expect(safeRel("docs/a.md")).toBe(join("docs", "a.md"));
    for (const bad of ["../x.md", "a/../../x", "C:/x.md", "a//b", "a/./b", "con:x"]) expect(() => safeRel(bad)).toThrow("位置不对");
  });
});
