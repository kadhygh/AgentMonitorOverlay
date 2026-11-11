import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage } from "electron";
import { safeFileName } from "./viewer-rules.js";

// 另存为 (2026-11-11, the user: 图片上按右键弹出菜单，可以「另存为…」，弹出系统的保存对话框选位置 — the controlling computer
// and the usual Reviewer both): the page asks with the file's name and its bytes (it read them from the Host it already
// talks to: this computer's file, or a remote task's copy fetched through this Host), or only an address when it
// could not read it itself (a picture of a page from the web); the system's save dialog picks the place, then the file
// is written there. AMO Studio and the AMO Reviewer program both install it for their windows (one Reviewer, AGENTS.md 第 4 条).

export interface SaveFileAsk {
  /** The name offered in the dialog. */
  name: string;
  bytes?: Uint8Array;
  /** http(s) or data: — read here when the page could not read it. */
  url?: string;
}

export type SaveFileResult = { saved: true; path: string } | { saved: false; error?: string };

async function bytesOf(ask: { bytes?: Uint8Array; url?: string }): Promise<Uint8Array> {
  if (ask.bytes instanceof Uint8Array) return ask.bytes;
  const url = typeof ask.url === "string" ? ask.url : "";
  if (!/^(https?:|data:)/i.test(url)) throw new Error("没有可以保存的内容");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读不到这个文件（${r.status}）`);
  return new Uint8Array(await r.arrayBuffer());
}

/** `amo:save-file` for every window of the program; call once. */
export function installSaveFile(): void {
  // `dialog.showSaveDialog` is looked up at each call: the e2e tests put their own in its place.
  ipcMain.handle("amo:save-file", async (event, input: unknown): Promise<SaveFileResult> => {
    const ask = (input ?? {}) as SaveFileAsk;
    const name = safeFileName(ask.name);
    const ext = extname(name).slice(1).toLowerCase();
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      title: "另存为",
      defaultPath: join(app.getPath("downloads"), name),
      filters: [...(ext ? [{ name: `${ext.toUpperCase()} 文件`, extensions: [ext] }] : []), { name: "所有文件", extensions: ["*"] }],
    };
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { saved: false };
    try {
      await writeFile(picked.filePath, await bytesOf(ask));
      return { saved: true, path: picked.filePath };
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// 复制图片 (2026-11-11, the user: Reviewer 里打开的是图片时，按 Ctrl+C 直接把这张图片复制到剪贴板，复制的是图片本身，不是路径，
// 粘贴到微信、Word、画图里就是这张图): as 另存为, the page reads the picture from its Host and hands the bytes here;
// nativeImage reads it (PNG and JPEG only, so the page turns any other kind — GIF, WebP, BMP, SVG, ICO — into PNG
// first, from the <img> it has already drawn: lib/saveFile.ts) and it goes on the clipboard as a picture. Electron 44
// has no clipboard.writeImage any more: its clipboard takes W3C ClipboardItems, so the picture goes as image/png (as
// 便签's 复制 does, notes/src/main.ts).

export interface CopyImageAsk {
  bytes?: Uint8Array;
  /** http(s) or data: — read here when the page could not read it (a picture of a page from the web). */
  url?: string;
}

export type CopyImageResult = { copied: true; width: number; height: number } | { copied: false; error: string };

/**
 * `amo:copy-image` for every window of the program; call once. `testMode`: the tests never take the person's
 * clipboard (HANDOFF 规则): the picture's size is recorded instead, as `amo:copy` records text.
 */
export function installCopyImage({ testMode = false }: { testMode?: boolean } = {}): void {
  ipcMain.handle("amo:copy-image", async (_event, input: unknown): Promise<CopyImageResult> => {
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(await bytesOf((input ?? {}) as CopyImageAsk)));
      if (image.isEmpty()) return { copied: false, error: "这种格式的图片复制不了（只能复制 PNG、JPEG，或者先另存为再复制）" };
      const { width, height } = image.getSize();
      if (testMode) ((globalThis as { __amoCopiedImages?: Array<{ width: number; height: number }> }).__amoCopiedImages ??= []).push({ width, height });
      else await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
      return { copied: true, width, height };
    } catch (err) {
      return { copied: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
