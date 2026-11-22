import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDevice } from "@amo-studio/account";
import { TransferFiles } from "./transfer-files.js";

// 传文件's side of the shell (2026-11-23): one IPC channel, `relay:transfer`, method + arguments, for relayShell.transfer
// (preload.cts). The pickers are the system's; in tests (AMO_RELAY_TEST) they take what the test queued instead
// (`__relayQueuePick(paths | null)`), and 打开文件夹 only records what it would open (`__relayOpened()`), so no window
// of Explorer or a dialog ever shows up during e2e. The receiving folder is kept in <home>/transfer.json.

export function wireTransfer(opts: { home: string; testMode: boolean; win: () => BrowserWindow | null }): void {
  const files = new TransferFiles(opts.home);
  const settingsFile = join(opts.home, "transfer.json");
  const queued: Array<string[] | null> = [];
  const opened: string[] = [];
  if (opts.testMode) Object.assign(globalThis, { __relayQueuePick: (paths: string[] | null) => void queued.push(paths), __relayOpened: () => [...opened] });

  const defaultDir = () => join(opts.testMode ? join(opts.home, "Downloads") : app.getPath("downloads"), "AMO 中转");
  const receiveDir = (): string => {
    try {
      const dir = (JSON.parse(readFileSync(settingsFile, "utf8")) as { receiveDir?: unknown }).receiveDir;
      if (typeof dir === "string" && dir.trim()) return dir;
    } catch {
      // not set yet
    }
    return defaultDir();
  };

  const ask = async (kind: "files" | "folder" | "dir", current?: string): Promise<string[] | null> => {
    if (opts.testMode) return queued.shift() ?? null;
    const w = opts.win();
    const props: Array<"openFile" | "openDirectory" | "multiSelections" | "createDirectory"> = kind === "files" ? ["openFile", "multiSelections"] : kind === "folder" ? ["openDirectory", "multiSelections"] : ["openDirectory", "createDirectory"];
    const title = kind === "files" ? "选要发的文件" : kind === "folder" ? "选要发的文件夹" : "收到的文件存到哪里";
    const r = w ? await dialog.showOpenDialog(w, { title, properties: props, defaultPath: current }) : await dialog.showOpenDialog({ title, properties: props, defaultPath: current });
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  };

  const methods: Record<string, (...args: never[]) => unknown> = {
    device: () => ensureDevice(),
    pickFiles: async (addTo?: string | null) => {
      const paths = await ask("files");
      return paths ? files.pick(paths, addTo) : null;
    },
    pickFolder: async (addTo?: string | null) => {
      const paths = await ask("folder");
      return paths ? files.pick(paths, addTo) : null;
    },
    dropped: (paths: string[], addTo?: string | null) => (Array.isArray(paths) && paths.length ? files.pick(paths.filter((p) => typeof p === "string" && p), addTo) : null),
    bind: (pick: string, id: string, keep?: string[]) => files.bind(pick, id, keep),
    read: (id: string, path: string, offset: number, length: number) => files.readPiece(id, path, offset, length),
    hash: (id: string, path: string) => files.sourceHash(id, path),
    forgetSend: (id: string) => files.forgetSend(id),
    receiveDir: () => receiveDir(),
    setReceiveDir: (dir: string) => {
      if (typeof dir !== "string" || !dir.trim()) throw new Error("文件夹不对");
      const abs = resolve(dir);
      mkdirSync(opts.home, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({ receiveDir: abs }, null, 2));
      return abs;
    },
    chooseDir: async (current?: string) => (await ask("dir", current))?.[0] ?? null,
    prepare: (id: string, dir: string, plan: { roots: string[]; folders: string[]; dirs: string[] }) => files.prepare(id, dir, plan),
    received: (id: string) => files.received(id),
    partSize: (id: string, path: string) => files.partSize(id, path),
    write: (id: string, path: string, offset: number, data: Uint8Array) => files.writePiece(id, path, offset, data),
    finish: (id: string, path: string, sha256: string) => files.finish(id, path, sha256),
    discard: (id: string) => files.discard(id),
    openFolder: async (id: string) => {
      const where = files.shown(id);
      if (!where) throw new Error("这台电脑上没有这次接收的记录");
      if (opts.testMode) return void opened.push(where.item ?? where.dir);
      if (where.item) shell.showItemInFolder(where.item);
      else await shell.openPath(where.dir);
    },
    prune: (keep: string[]) => files.prune(Array.isArray(keep) ? keep : []),
  };

  ipcMain.handle("relay:transfer", (_e, method: unknown, ...args: unknown[]) => {
    const run = typeof method === "string" && Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!run) throw new Error(`没有这个操作：${String(method)}`);
    return (run as (...a: unknown[]) => unknown)(...args);
  });
}
