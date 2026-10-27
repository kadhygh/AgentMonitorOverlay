// Sandboxed preload of the AMO 中转 window (CommonJS): `relayLoader` for the shell's loader page, `relayShell` for the
// client content (its shape: @amo-studio/relay shell-api.ts).
import electron = require("electron");

const { ipcRenderer } = electron;
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`relay:${channel}`, ...args);
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
  saveAccount: (account: unknown) => invoke("save-account", account),
  forgetAccount: (server: string, name: string) => invoke("forget-account", server, name),
  signedIn: (identity: unknown) => invoke("signed-in", identity),
  mcp: () => invoke("mcp"),
  copy: (text: string) => invoke("copy", text),
  notify: (n: unknown) => send("notify", n),
  onOpenThread: (listener: (id: string) => void) => on("open-thread", listener),
  setUnread: (count: number) => send("unread", count),
  checkUpdate: () => invoke("check-update"),
  applyUpdate: () => invoke("apply-update"),
  onUpdateProgress: (listener: (p: unknown) => void) => on("update-progress", listener),
  inUse: () => invoke("in-use"),
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
});
