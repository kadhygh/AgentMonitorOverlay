// Sandboxed preload of the 便签 program's windows (CommonJS). The same `window.amo` names Studio's preload uses for
// what the scratchpad window needs (host, copyText, scratchpad), so that window runs unchanged; `notes` is its own.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("amo", {
  host: (): Promise<{ url: string; token: string } | null> => electron.ipcRenderer.invoke("amo:host"),
  copyText: (text: string): Promise<void> => electron.ipcRenderer.invoke("amo:copy", text),
  scratchpad: {
    open: (): Promise<void> => electron.ipcRenderer.invoke("amo:scratchpad-open"),
    hide: (): void => electron.ipcRenderer.send("amo:scratchpad-hide"),
    applyShortcut: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:scratchpad-shortcut-apply"),
    shortcutStatus: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:scratchpad-shortcut-status"),
  },
  /** The 便签 program (2026-10-23): it is not inside Studio. */
  notes: {
    openSettings: (): Promise<void> => electron.ipcRenderer.invoke("amo:notes-open-settings"),
    closeSettings: (): void => electron.ipcRenderer.send("amo:notes-close-settings"),
    pickFolder: (start?: string | null): Promise<string | null> => electron.ipcRenderer.invoke("amo:notes-pick-folder", start ?? undefined),
  },
});
