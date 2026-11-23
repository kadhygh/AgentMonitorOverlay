// Sandboxed preload of the AMO 中转 window (CommonJS): `relayLoader` for the shell's loader page, `relayShell` for the
// client content (its shape: @amo-studio/relay shell-api.ts).
import electron = require("electron");

const { ipcRenderer } = electron;
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`relay:${channel}`, ...args);
const tx = (method: string, ...args: unknown[]) => ipcRenderer.invoke("relay:transfer", method, ...args);
const send = (channel: string, ...args: unknown[]) => ipcRenderer.send(`relay:${channel}`, ...args);
const on = (channel: string, listener: (value: never) => void) => {
  ipcRenderer.removeAllListeners(`relay:${channel}`);
  ipcRenderer.on(`relay:${channel}`, (_e, value) => listener(value as never));
};

electron.contextBridge.exposeInMainWorld("relayLoader", {
  onState: (listener: (s: unknown) => void) => on("loader-state", listener),
  ready: () => send("loader-ready"),
  submitServer: (server: string) => send("loader-server", server),
  retry: () => send("loader-retry"),
  changeServer: () => send("change-server"),
  open: (url: string) => send("open-external", url),
  window: (action: string) => send("window", action),
  platform: process.platform,
});

electron.contextBridge.exposeInMainWorld("relayShell", {
  info: () => invoke("info"),
  accounts: () => invoke("accounts"),
  platformAccount: () => invoke("platform-account"),
  saveAccount: (account: unknown) => invoke("save-account", account),
  forgetAccount: (server: string, name: string) => invoke("forget-account", server, name),
  signedIn: (identity: unknown) => invoke("signed-in", identity),
  mcp: () => invoke("mcp"),
  copy: (text: string) => invoke("copy", text),
  notify: (n: unknown) => send("notify", n),
  onOpenThread: (listener: (id: string) => void) => on("open-thread", listener),
  onOpen: (listener: (ref: string) => void) => on("open", listener),
  setUnread: (count: number) => send("unread", count),
  checkUpdate: () => invoke("check-update"),
  applyUpdate: () => invoke("apply-update"),
  onUpdateProgress: (listener: (p: unknown) => void) => on("update-progress", listener),
  inUse: () => invoke("in-use"),
  updateShell: () => invoke("update-shell"),
  onShellProgress: (listener: (p: unknown) => void) => on("shell-progress", listener),
  windowControls: {
    minimize: () => send("window", "minimize"),
    toggleMaximize: () => send("window", "maximize"),
    close: () => send("window", "close"),
    isMaximized: () => invoke("window-maximized"),
    onMaximized: (listener: (m: boolean) => void) => on("maximized", listener),
  },
  writeUsage: (text: string) => invoke("write-usage", text),
  changeServer: () => send("change-server"),
  openExternal: (url: string) => send("open-external", url),
  takeOpenThread: () => invoke("take-open-thread"),
  takeOpen: () => invoke("take-open"),
  studioHas: (conv: string) => invoke("studio-has", conv),
  openInStudio: (conv: string) => invoke("open-in-studio", conv),
  // 传文件 (2026-11-23, transfer-ipc.ts): one channel, method + arguments. Dropped files become paths here (webUtils),
  // the only place that can tell them.
  transfer: {
    device: () => tx("device"),
    pickFiles: (addTo?: string | null) => tx("pickFiles", addTo ?? null),
    pickFolder: (addTo?: string | null) => tx("pickFolder", addTo ?? null),
    dropped: (files: File[], addTo?: string | null) => tx("dropped", [...files].map((f) => electron.webUtils.getPathForFile(f)).filter(Boolean), addTo ?? null),
    bind: (pick: string, id: string, keep?: string[]) => tx("bind", pick, id, keep),
    read: (id: string, path: string, offset: number, length: number) => tx("read", id, path, offset, length),
    hash: (id: string, path: string) => tx("hash", id, path),
    forgetSend: (id: string) => tx("forgetSend", id),
    receiveDir: () => tx("receiveDir"),
    setReceiveDir: (dir: string) => tx("setReceiveDir", dir),
    chooseDir: (current?: string) => tx("chooseDir", current),
    prepare: (id: string, dir: string, plan: unknown) => tx("prepare", id, dir, plan),
    received: (id: string) => tx("received", id),
    partSize: (id: string, path: string) => tx("partSize", id, path),
    write: (id: string, path: string, offset: number, data: Uint8Array) => tx("write", id, path, offset, data),
    finish: (id: string, path: string, sha256: string) => tx("finish", id, path, sha256),
    discard: (id: string) => tx("discard", id),
    openFolder: (id: string) => tx("openFolder", id),
    prune: (keep: string[]) => tx("prune", keep),
  },
});
