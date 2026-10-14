import { DEFAULT_SCRATCHPAD_SHORTCUT, normalizeShortcut, SCRATCHPAD_MAX_IMAGES, SCRATCHPAD_MAX_PAGES, SCRATCHPAD_MAX_TEXT, type Scratchpad } from "@amo-studio/protocol";
import { HostError, SCRATCHPAD_KEY } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { readScratchpad, visibleScratchpad, withPage, withPageCount, type StoredScratchpad } from "./doc.js";

/** The document, as JSON. Stage 2's plain text stays under SCRATCHPAD_KEY and is read only until this exists. */
const DOC_KEY = "scratchpad:doc";
/** The window's global shortcut; absent means the default, "" means off. */
const SHORTCUT_KEY = "settings:scratchpad-shortcut";
/** 复制 joins lines (安全换行) when "1"; absent or anything else: lines kept (S14-B default). */
const SAFE_NEWLINES_KEY = "settings:scratchpad-safe-newlines";

/**
 * The scratchpad (便签, stage 11; stage 2's draft area grown up): numbered pages of text and pasted images, shared by
 * the scratchpad window and the task page. Every change is announced, so all windows follow.
 */
export class ScratchpadFeature extends Feature {
  scratchpad(): Scratchpad {
    const kv = this.store.getKv(DOC_KEY);
    return visibleScratchpad(this.stored(), kv?.updatedAt ?? this.store.getKv(SCRATCHPAD_KEY)?.updatedAt ?? null);
  }

  /** Switches the page every window shows and/or sets the page count. */
  update(input: { activePage?: unknown; pageCount?: unknown }): Scratchpad {
    let doc = this.stored();
    if (input.pageCount !== undefined) doc = withPageCount(doc, this.number(input.pageCount, "pageCount", 1, SCRATCHPAD_MAX_PAGES));
    if (input.activePage !== undefined) doc = { ...doc, activePage: this.number(input.activePage, "activePage", 0, doc.pageCount - 1) };
    return this.save(doc);
  }

  /** Replaces the text and/or the images of a page (1-based). */
  savePage(pageParam: string, input: { text?: unknown; attachments?: unknown }): Scratchpad {
    const index = this.number(Number(pageParam), "page", 1, SCRATCHPAD_MAX_PAGES) - 1;
    const patch: { text?: string; attachments?: string[] } = {};
    if (input.text !== undefined) {
      if (typeof input.text !== "string") throw new HostError("bad_request", "text must be a string");
      if (input.text.length > SCRATCHPAD_MAX_TEXT) throw new HostError("bad_request", `a page is limited to ${SCRATCHPAD_MAX_TEXT} characters`);
      patch.text = input.text;
    }
    if (input.attachments !== undefined) {
      const ids = input.attachments;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new HostError("bad_request", "attachments must be a list of attachment ids");
      const unique = [...new Set(ids as string[])];
      if (unique.length > SCRATCHPAD_MAX_IMAGES) throw new HostError("bad_request", `a page holds at most ${SCRATCHPAD_MAX_IMAGES} images`);
      for (const id of unique) {
        try {
          this.f.attachments.get(id);
        } catch {
          throw new HostError("bad_request", `attachment ${id} not found`);
        }
      }
      patch.attachments = unique;
    }
    return this.save(withPage(this.stored(), index, patch));
  }

  /** The window's global shortcut (设置 → 便签); "" when turned off. */
  shortcut(): string {
    return this.store.getKv(SHORTCUT_KEY)?.value ?? DEFAULT_SCRATCHPAD_SHORTCUT;
  }

  /** Stores a new shortcut (canonical form); the app's main process registers it. Called from 设置 (config). */
  setShortcut(value: unknown): void {
    const shortcut = typeof value === "string" ? normalizeShortcut(value) : null;
    if (shortcut === null) throw new HostError("bad_request", `「${String(value)}」不能用作快捷键：需要 Ctrl、Alt 或 Win 加一个键，或者单独的 F1–F24`);
    this.store.setKv(SHORTCUT_KEY, shortcut);
  }

  /** Whether 复制 joins the page's lines into one (安全换行, 设置 → 便签). */
  safeNewlines(): boolean {
    return this.store.getKv(SAFE_NEWLINES_KEY)?.value === "1";
  }

  setSafeNewlines(value: unknown): void {
    if (typeof value !== "boolean") throw new HostError("bad_request", "scratchpadSafeNewlines must be true or false");
    this.store.setKv(SAFE_NEWLINES_KEY, value ? "1" : "0");
  }

  private stored(): StoredScratchpad {
    return readScratchpad(this.store.getKv(DOC_KEY)?.value, this.store.getKv(SCRATCHPAD_KEY)?.value);
  }

  private save(doc: StoredScratchpad): Scratchpad {
    const kv = this.store.setKv(DOC_KEY, JSON.stringify(doc));
    const scratchpad = visibleScratchpad(doc, kv.updatedAt);
    this.publish({ type: "scratchpad.updated", scratchpad });
    return scratchpad;
  }

  private number(value: unknown, field: string, min: number, max: number): number {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new HostError("bad_request", `${field} must be a whole number from ${min} to ${max}`);
    return n;
  }
}
