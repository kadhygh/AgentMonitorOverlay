import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { PackError, PackLoader, resolveInside } from "./pack-loader.js";

let root: string;
let ws: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-packs-"));
  ws = join(root, "ws");
  mkdirSync(ws);
});
afterEach(() => removeTempDir(root));

function pack(name: string, manifest: unknown, files: Record<string, string> = {}) {
  const dir = join(ws, ".amo", "packs", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const demo = { schemaVersion: 1, name: "demo", title: "示例", docs: [{ id: "style", title: "规范", path: "docs/style.md" }] };

/** Directory links: junctions need no privilege on Windows. */
function linkDir(target: string, path: string) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("PackLoader", () => {
  it("finds no packs in a workspace without .amo/packs", () => {
    expect(new PackLoader().list(ws)).toEqual([]);
  });

  it("lists valid and broken packs side by side", () => {
    pack("demo", demo, { "docs/style.md": "# 规范\n\n用驼峰命名。" });
    pack("broken", "{ not json");
    pack("invalid", { schemaVersion: 1, name: "invalid" });
    mkdirSync(join(ws, ".amo", "packs", "empty"));
    const list = new PackLoader().list(ws);
    expect(list.map((p) => [p.dirName, p.manifest?.title ?? null, p.errors.length > 0])).toEqual([
      ["broken", null, true],
      ["demo", "示例", false],
      ["empty", null, true],
      ["invalid", null, true],
    ]);
    expect(list[0]!.errors[0]).toMatch(/^pack\.json 不是有效的 JSON/);
    expect(list[2]!.errors).toEqual(["缺少 pack.json"]);
    expect(list[3]!.errors).toEqual(["title: 必填，应为字符串"]);
  });

  it("warns about missing documents and a name that differs from the directory", () => {
    pack("other", { ...demo, name: "demo" });
    const [p] = new PackLoader().list(ws);
    expect(p!.manifest).not.toBeNull();
    expect(p!.warnings).toEqual(['name "demo" 和目录名 "other" 不同', "docs[0]: 文件 docs/style.md 不存在，或指到了扩展包外面"]);
  });

  it("reads a document, and refuses missing, unknown and oversized ones", () => {
    pack("demo", { ...demo, docs: [...demo.docs, { id: "big", title: "大", path: "big.md" }, { id: "gone", title: "无", path: "gone.md" }] }, { "docs/style.md": "# 规范", "big.md": "x".repeat(512 * 1024 + 1) });
    const loader = new PackLoader();
    expect(loader.readDoc(ws, "demo", "style")).toEqual({ pack: "demo", id: "style", title: "规范", path: "docs/style.md", text: "# 规范" });
    const fails = (p: string, d: string) => {
      try {
        loader.readDoc(ws, p, d);
        return null;
      } catch (err) {
        return [(err as PackError).kind, (err as Error).message];
      }
    };
    expect(fails("demo", "big")).toEqual(["bad_request", "文档 big.md 太大（524289 字节，最多 524288）"]);
    expect(fails("demo", "gone")).toEqual(["not_found", "文档 gone.md 不存在，或指到了扩展包外面"]);
    expect(fails("demo", "nope")).toEqual(["not_found", "扩展包 demo 里没有文档 nope"]);
    expect(fails("nope", "style")).toEqual(["not_found", "扩展包 nope 不存在"]);
  });

  it("does not follow links out of the pack or the workspace", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    writeFileSync(join(outside, "pack.json"), JSON.stringify({ ...demo, docs: [] }));
    // A doc directory that links outside the pack.
    const dir = pack("demo", { ...demo, docs: [{ id: "leak", title: "L", path: "linked/secret.md" }] });
    linkDir(outside, join(dir, "linked"));
    const loader = new PackLoader();
    expect(() => loader.readDoc(ws, "demo", "leak")).toThrow("文档 linked/secret.md 不存在，或指到了扩展包外面");
    // A pack directory that links outside the workspace is skipped.
    linkDir(outside, join(ws, ".amo", "packs", "escaped"));
    expect(loader.list(ws).map((p) => p.dirName)).toEqual(["demo"]);
    // .amo itself linking outside: no packs at all.
    const ws2 = join(root, "ws2");
    mkdirSync(ws2);
    mkdirSync(join(outside, "packs", "x"), { recursive: true });
    linkDir(outside, join(ws2, ".amo"));
    expect(loader.list(ws2)).toEqual([]);
  });

  it("re-reads a manifest when it changes", () => {
    const dir = pack("demo", demo, { "docs/style.md": "#" });
    const loader = new PackLoader();
    expect(loader.list(ws)[0]!.manifest!.title).toBe("示例");
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ ...demo, title: "示例 v2" }));
    utimesSync(join(dir, "pack.json"), new Date(), new Date(Date.now() + 5000));
    expect(loader.list(ws)[0]!.manifest!.title).toBe("示例 v2");
  });
});

describe("resolveInside", () => {
  it("keeps paths inside their base", () => {
    writeFileSync(join(ws, "a.txt"), "a");
    expect(resolveInside(ws, "a.txt")).toMatch(/a\.txt$/);
    expect(resolveInside(ws, "../ws/a.txt")).toBeNull();
    expect(resolveInside(ws, "missing.txt")).toBeNull();
    expect(resolveInside(ws, ".")).toBeNull();
  });
});
