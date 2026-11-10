import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
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

async function bytesOf(ask: SaveFileAsk): Promise<Uint8Array> {
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
