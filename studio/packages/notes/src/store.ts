import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ATTACHMENT_MIMES,
  DEFAULT_SCRATCHPAD_SHORTCUT,
  MAX_ATTACHMENT_BYTES,
  normalizeShortcut,
  readScratchpad,
  SCRATCHPAD_MAX_IMAGES,
  SCRATCHPAD_MAX_PAGES,
  SCRATCHPAD_MAX_TEXT,
  visibleScratchpad,
  withPage,
  withPageCount,
  type Attachment,
  type Scratchpad,
  type StoredScratchpad,
} from "@amo-studio/protocol";

// What the 便签 program keeps (2026-10-23), in two places:
// - its home (%APPDATA%\AMO Notes, or AMO_NOTES_HOME): settings.json, always there, whichever work folder is in use;
// - its work folder (home\data unless the person chose another): pages.json, images\ (pasted images, <id><ext> with
//   <id>.json beside it, as Studio kept them) and cache\ (temporary files; 清理缓存 empties it).

export class NotesError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface NotesSettings {
  /** The work folder; null: the default one in the home. */
  workFolder: string | null;
  /** The global shortcut that shows and hides the window; "" when off. */
  shortcut: string;
  /** 复制 joins the lines into one (安全换行). */
  safeNewlines: boolean;
  /** Start with Windows, in the tray only. */
  openAtLogin: boolean;
  /** When the pages were brought over from AMO Studio (once); null before. */
  importedAt: string | null;
  /** The notice about that import was closed. */
  importNoticeSeen: boolean;
  /** The windows' zoom (界面大小), as AMO Studio's: Studio keeps it in step. */
  uiScale: number;
}

export interface FolderUsage {
  /** pages.json */
  pages: number;
  /** Images some page (shown or kept) holds. */
  images: number;
  /** Images no page holds any more, and cache\. */
  cache: number;
}

const DEFAULTS: NotesSettings = { workFolder: null, shortcut: DEFAULT_SCRATCHPAD_SHORTCUT, safeNewlines: false, openAtLogin: false, importedAt: null, importNoticeSeen: false, uiScale: 1 };
/** The zooms Studio offers (app/src/focus-window.ts UI_SCALES spans these). */
const scaleOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0.75 && n <= 1.6;
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const IMAGE_ID = /^att-[0-9a-f-]{36}$/;

/** Writes through a temporary file, so a crash never leaves half a file. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0);
}

export class NotesStore {
  private settingsCache: NotesSettings | null = null;

  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true });
  }

  // ---- settings ---------------------------------------------------------------------------------------------------

  get settingsFile(): string {
    return join(this.home, "settings.json");
  }

  settings(): NotesSettings {
    if (this.settingsCache) return this.settingsCache;
    const o = readJson(this.settingsFile) ?? {};
    const shortcut = typeof o.shortcut === "string" ? normalizeShortcut(o.shortcut) : null;
    this.settingsCache = {
      workFolder: typeof o.workFolder === "string" && o.workFolder ? o.workFolder : null,
      shortcut: shortcut ?? DEFAULTS.shortcut,
      safeNewlines: o.safeNewlines === true,
      openAtLogin: o.openAtLogin === true,
      importedAt: typeof o.importedAt === "string" ? o.importedAt : null,
      importNoticeSeen: o.importNoticeSeen === true,
      uiScale: scaleOk(o.uiScale) ? o.uiScale : DEFAULTS.uiScale,
    };
    return this.settingsCache;
  }

  updateSettings(patch: Partial<Record<keyof NotesSettings, unknown>>): NotesSettings {
    const next = { ...this.settings() };
    if (patch.shortcut !== undefined) {
      const s = typeof patch.shortcut === "string" ? normalizeShortcut(patch.shortcut) : null;
      if (s === null) throw new NotesError("bad_request", "这个快捷键不能用：要带 Ctrl、Alt 或 Win，F1–F24 可以单独用");
      next.shortcut = s;
    }
    if (patch.safeNewlines !== undefined) next.safeNewlines = patch.safeNewlines === true;
    if (patch.openAtLogin !== undefined) next.openAtLogin = patch.openAtLogin === true;
    if (patch.importNoticeSeen !== undefined) next.importNoticeSeen = patch.importNoticeSeen === true;
    if (patch.uiScale !== undefined) {
      if (!scaleOk(patch.uiScale)) throw new NotesError("bad_request", "uiScale must be a number from 0.75 to 1.6");
      next.uiScale = patch.uiScale;
    }
    if (patch.importedAt !== undefined) next.importedAt = typeof patch.importedAt === "string" ? patch.importedAt : null;
    if (patch.workFolder !== undefined) next.workFolder = typeof patch.workFolder === "string" && patch.workFolder ? resolve(patch.workFolder) : null;
    writeAtomic(this.settingsFile, JSON.stringify(next, null, 2));
    this.settingsCache = next;
    return next;
  }

  // ---- the work folder --------------------------------------------------------------------------------------------

  get defaultFolder(): string {
    return join(this.home, "data");
  }

  get folder(): string {
    return this.settings().workFolder ?? this.defaultFolder;
  }

  private get pagesFile(): string {
    return join(this.folder, "pages.json");
  }

  get imagesDir(): string {
    return join(this.folder, "images");
  }

  get cacheDir(): string {
    return join(this.folder, "cache");
  }

  private stored(): { doc: StoredScratchpad; updatedAt: string | null } {
    const raw = existsSync(this.pagesFile) ? readFileSync(this.pagesFile, "utf8") : undefined;
    const o = raw ? readJson(this.pagesFile) : null;
    return { doc: readScratchpad(raw, undefined), updatedAt: typeof o?.updatedAt === "string" ? o.updatedAt : null };
  }

  private save(doc: StoredScratchpad): Scratchpad {
    const updatedAt = new Date().toISOString();
    writeAtomic(this.pagesFile, JSON.stringify({ ...doc, updatedAt }, null, 2));
    return visibleScratchpad(doc, updatedAt);
  }

  scratchpad(): Scratchpad {
    const { doc, updatedAt } = this.stored();
    return visibleScratchpad(doc, updatedAt);
  }

  /** Whether the folder holds anything written (an empty one can take Studio's pages). */
  isEmpty(): boolean {
    const { doc } = this.stored();
    return doc.pages.every((p) => !p.text && !p.attachments.length);
  }

  update(input: { activePage?: unknown; pageCount?: unknown }): Scratchpad {
    let { doc } = this.stored();
    if (input.pageCount !== undefined) doc = withPageCount(doc, this.number(input.pageCount, "pageCount", 1, SCRATCHPAD_MAX_PAGES));
    if (input.activePage !== undefined) doc = { ...doc, activePage: this.number(input.activePage, "activePage", 0, doc.pageCount - 1) };
    return this.save(doc);
  }

  /** Replaces the text and/or the images of a page (1-based). */
  savePage(pageParam: string, input: { text?: unknown; attachments?: unknown }): Scratchpad {
    const index = this.number(Number(pageParam), "page", 1, SCRATCHPAD_MAX_PAGES) - 1;
    const patch: { text?: string; attachments?: string[] } = {};
    if (input.text !== undefined) {
      if (typeof input.text !== "string") throw new NotesError("bad_request", "text must be a string");
      if (input.text.length > SCRATCHPAD_MAX_TEXT) throw new NotesError("bad_request", `a page is limited to ${SCRATCHPAD_MAX_TEXT} characters`);
      patch.text = input.text;
    }
    if (input.attachments !== undefined) {
      const ids = input.attachments;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new NotesError("bad_request", "attachments must be a list of image ids");
      const unique = [...new Set(ids as string[])];
      if (unique.length > SCRATCHPAD_MAX_IMAGES) throw new NotesError("bad_request", `a page holds at most ${SCRATCHPAD_MAX_IMAGES} images`);
      for (const id of unique) this.image(id);
      patch.attachments = unique;
    }
    return this.save(withPage(this.stored().doc, index, patch));
  }

  private number(value: unknown, name: string, lo: number, hi: number): number {
    const n = typeof value === "number" ? value : Number.NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) throw new NotesError("bad_request", `${name} must be a whole number from ${lo} to ${hi}`);
    return n;
  }

  // ---- images -----------------------------------------------------------------------------------------------------

  saveImage(data: Buffer, input: { name?: unknown; mime?: unknown }): Attachment {
    const mime = typeof input.mime === "string" ? input.mime.split(";")[0]!.trim().toLowerCase() : "";
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(mime)) throw new NotesError("bad_request", `only images can be added (${ATTACHMENT_MIMES.join(", ")})`);
    if (!data.length) throw new NotesError("bad_request", "the file is empty");
    if (data.length > MAX_ATTACHMENT_BYTES) throw new NotesError("bad_request", "file too large");
    return this.writeImage(`att-${randomUUID()}`, data, mime, typeof input.name === "string" ? input.name : "");
  }

  private writeImage(id: string, data: Buffer, mime: string, rawName: string, createdAt = new Date().toISOString()): Attachment {
    const ext = EXT[mime]!;
    const name = (basename(rawName).trim() || `image${ext}`).slice(0, 120);
    mkdirSync(this.imagesDir, { recursive: true });
    const path = join(this.imagesDir, id + ext);
    writeFileSync(path, data);
    const image: Attachment = { id, name, mime, size: data.length, path, createdAt };
    writeFileSync(join(this.imagesDir, `${id}.json`), JSON.stringify(image));
    return image;
  }

  image(id: string): Attachment {
    const meta = IMAGE_ID.test(id) ? join(this.imagesDir, `${id}.json`) : "";
    const o = meta && existsSync(meta) ? readJson(meta) : null;
    if (!o) throw new NotesError("not_found", `image ${id} not found`);
    // The folder may have moved since: the file is the one beside its record.
    const mime = String(o.mime);
    return { ...(o as unknown as Attachment), path: join(this.imagesDir, id + (EXT[mime] ?? "")) };
  }

  // ---- usage, cache -----------------------------------------------------------------------------------------------

  /** The images some page holds, the shown pages and the kept ones beyond the count. */
  private usedImages(): Set<string> {
    return new Set(this.stored().doc.pages.flatMap((p) => p.attachments));
  }

  private imageFiles(): Array<{ id: string; files: string[] }> {
    if (!existsSync(this.imagesDir)) return [];
    const byId = new Map<string, string[]>();
    for (const name of readdirSync(this.imagesDir)) {
      const id = name.replace(/(\.json|\.[a-z]+)$/i, "");
      if (!IMAGE_ID.test(id)) continue;
      byId.set(id, [...(byId.get(id) ?? []), join(this.imagesDir, name)]);
    }
    return [...byId].map(([id, files]) => ({ id, files }));
  }

  usage(): FolderUsage {
    const used = this.usedImages();
    let images = 0;
    let unused = 0;
    for (const { id, files } of this.imageFiles()) {
      const n = files.reduce((s, f) => s + sizeOf(f), 0);
      if (used.has(id)) images += n;
      else unused += n;
    }
    return { pages: sizeOf(this.pagesFile), images, cache: unused + sizeOf(this.cacheDir) };
  }

  /** Deletes the images no page holds and empties cache\; returns the bytes freed. */
  clearCache(): number {
    const before = this.usage().cache;
    const used = this.usedImages();
    for (const { id, files } of this.imageFiles()) if (!used.has(id)) for (const f of files) rmSync(f, { force: true });
    rmSync(this.cacheDir, { recursive: true, force: true });
    mkdirSync(this.cacheDir, { recursive: true });
    return before;
  }

  // ---- moving the work folder -------------------------------------------------------------------------------------

  /**
   * Switches to another work folder. `move`: the pages and images are copied there first (the old folder is left as
   * it is); otherwise the new folder is used as it is (its own pages, or empty).
   */
  changeFolder(target: string, move: boolean): Scratchpad {
    const to = resolve(target);
    const from = resolve(this.folder);
    if (to.toLowerCase() === from.toLowerCase()) throw new NotesError("bad_request", "这就是现在的工作文件夹");
    if (to.toLowerCase().startsWith(`${from.toLowerCase()}\\`) || to.toLowerCase().startsWith(`${from.toLowerCase()}/`)) {
      throw new NotesError("bad_request", "新的工作文件夹不能放在现在这个里面");
    }
    mkdirSync(to, { recursive: true });
    if (move) {
      if (existsSync(join(to, "pages.json"))) throw new NotesError("conflict", "那个文件夹里已经有便签了：换一个空文件夹，或者选「不迁移」直接用它的");
      if (existsSync(this.pagesFile)) cpSync(this.pagesFile, join(to, "pages.json"));
      if (existsSync(this.imagesDir)) cpSync(this.imagesDir, join(to, "images"), { recursive: true });
    }
    mkdirSync(join(to, "cache"), { recursive: true });
    this.updateSettings({ workFolder: to.toLowerCase() === resolve(this.defaultFolder).toLowerCase() ? null : to });
    return this.scratchpad();
  }

  // ---- bringing pages over from AMO Studio -----------------------------------------------------------------------

  /**
   * Takes Studio's pages (once): only into an empty folder. Images come as their files; each keeps its id.
   * Returns how many pages held something and how many images came.
   */
  importFromStudio(input: { pages: Array<{ text: string; attachments: string[] }>; pageCount: number; activePage: number; images: Array<{ id: string; name: string; mime: string; path: string; createdAt?: string }> }): { pages: number; images: number } {
    if (this.settings().importedAt) throw new NotesError("conflict", "already imported");
    if (!this.isEmpty()) throw new NotesError("conflict", "the work folder already holds notes");
    let images = 0;
    const known = new Set<string>();
    for (const img of input.images) {
      if (!IMAGE_ID.test(img.id) || !EXT[img.mime] || !existsSync(img.path)) continue;
      this.writeImage(img.id, readFileSync(img.path), img.mime, img.name, img.createdAt);
      known.add(img.id);
      images++;
    }
    const pages = input.pages.slice(0, SCRATCHPAD_MAX_PAGES).map((p) => ({ text: String(p.text ?? "").slice(0, SCRATCHPAD_MAX_TEXT), attachments: (p.attachments ?? []).filter((id) => known.has(id)) }));
    const raw = JSON.stringify({ pages, pageCount: input.pageCount, activePage: input.activePage });
    this.save(readScratchpad(raw, undefined));
    this.updateSettings({ importedAt: new Date().toISOString(), importNoticeSeen: false });
    return { pages: pages.filter((p) => p.text || p.attachments.length).length, images };
  }
}
