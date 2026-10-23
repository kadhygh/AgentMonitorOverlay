import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotesStore } from "./store.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "amo-notes-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("NotesStore (the 便签 program's own files, 2026-10-23)", () => {
  it("keeps settings in its home and pages in the work folder, three empty pages to start", () => {
    const home = temp();
    const store = new NotesStore(home);
    expect(store.scratchpad().pages).toHaveLength(3);
    expect(store.isEmpty()).toBe(true);
    store.savePage("1", { text: "回复要点" });
    store.update({ pageCount: 5, activePage: 4 });
    expect(JSON.parse(readFileSync(join(home, "data", "pages.json"), "utf8"))).toMatchObject({ pageCount: 5, activePage: 4 });
    const again = new NotesStore(home).scratchpad();
    expect(again.pages[0]!.text).toBe("回复要点");
    expect(again.pages).toHaveLength(5);
    expect(again.activePage).toBe(4);

    store.updateSettings({ shortcut: "ctrl+alt+n", safeNewlines: true });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toMatchObject({ shortcut: "Ctrl+Alt+N", safeNewlines: true, workFolder: null });
    expect(() => store.updateSettings({ shortcut: "N" })).toThrow(/快捷键/);
  });

  it("counts what the folder takes, and clearing the cache drops only images no page holds", () => {
    const store = new NotesStore(temp());
    const kept = store.saveImage(PNG, { mime: "image/png", name: "a.png" });
    const dropped = store.saveImage(PNG, { mime: "image/png", name: "b.png" });
    store.savePage("1", { text: "x", attachments: [kept.id, dropped.id] });
    // A hidden page beyond the count still holds its image.
    const hidden = store.saveImage(PNG, { mime: "image/png" });
    store.update({ pageCount: 5 });
    store.savePage("5", { attachments: [hidden.id] });
    store.update({ pageCount: 3 });
    store.savePage("1", { attachments: [kept.id] });
    mkdirSync(store.cacheDir, { recursive: true });
    writeFileSync(join(store.cacheDir, "tmp.bin"), Buffer.alloc(100));
    const usage = store.usage();
    expect(usage.cache).toBeGreaterThan(100);
    expect(usage.images).toBeGreaterThan(0);

    const freed = store.clearCache();
    expect(freed).toBe(usage.cache);
    expect(store.usage().cache).toBe(0);
    expect(() => store.image(dropped.id)).toThrow();
    expect(store.image(kept.id).path).toMatch(/\.png$/);
    expect(store.image(hidden.id).name).toBe("image.png");
    expect(existsSync(store.cacheDir)).toBe(true);
  });

  it("moves to another work folder with its pages, or starts there without them; the old one is left as it was", () => {
    const home = temp();
    const store = new NotesStore(home);
    const img = store.saveImage(PNG, { mime: "image/png" });
    store.savePage("2", { text: "第二页", attachments: [img.id] });
    const target = join(temp(), "notes");

    store.changeFolder(target, true);
    expect(store.folder).toBe(target);
    expect(store.scratchpad().pages[1]).toEqual({ text: "第二页", attachments: [img.id] });
    expect(store.image(img.id).path.startsWith(target)).toBe(true);
    expect(existsSync(join(home, "data", "pages.json"))).toBe(true);
    // Settings stay in the home.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).workFolder).toBe(target);

    // Into a folder that already has notes: refused when moving, used as it is otherwise.
    expect(() => store.changeFolder(join(home, "data"), true)).toThrow(/已经有便签/);
    store.changeFolder(join(home, "data"), false);
    expect(store.settings().workFolder).toBeNull();
    expect(store.scratchpad().pages[1]!.text).toBe("第二页");
    const empty = join(temp(), "fresh");
    store.changeFolder(empty, false);
    expect(store.isEmpty()).toBe(true);
    expect(() => store.changeFolder(join(empty, "inside"), true)).toThrow(/不能放在/);
  });

  it("takes Studio's pages once, into an empty folder, images by file", () => {
    const studio = temp();
    const imgPath = join(studio, "att-11111111-1111-4111-8111-111111111111.png");
    writeFileSync(imgPath, PNG);
    const store = new NotesStore(temp());
    const input = {
      pages: [{ text: "Studio 里的", attachments: ["att-11111111-1111-4111-8111-111111111111", "att-missing"] }, { text: "", attachments: [] }, { text: "三", attachments: [] }],
      pageCount: 3,
      activePage: 2,
      images: [{ id: "att-11111111-1111-4111-8111-111111111111", name: "截图.png", mime: "image/png", path: imgPath }],
    };
    expect(store.importFromStudio(input)).toEqual({ pages: 2, images: 1 });
    expect(store.scratchpad()).toMatchObject({ activePage: 2, pages: [{ text: "Studio 里的", attachments: ["att-11111111-1111-4111-8111-111111111111"] }, { text: "" }, { text: "三" }] });
    expect(readdirSync(store.imagesDir)).toHaveLength(2);
    expect(store.settings().importedAt).not.toBeNull();
    expect(() => store.importFromStudio(input)).toThrow(/already imported/);
  });
});
