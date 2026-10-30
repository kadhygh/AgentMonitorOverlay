// Sandboxed preload of the 便签 program's windows (CommonJS). The same `window.amo` names Studio's preload uses for
// what the scratchpad window needs (host, copyText, scratchpad), so that window runs unchanged; `notes` is its own.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("amo", {
  host: (): Promise<{ url: string; token: string } | null> => electron.ipcRenderer.invoke("amo:host"),
  copyText: (text: string): Promise<void> => electron.ipcRenderer.invoke("amo:copy", text),
  /** 复制 with the page's pictures (2026-10-30). */
  copyRich: (input: { text: string; images: Uint8Array[] }): Promise<void> => electron.ipcRenderer.invoke("amo:copy-rich", input),
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
    /** The tray menu's choice: show the window, its settings, or quit. */
    trayAction: (action: "show" | "settings" | "quit" | "close"): void => electron.ipcRenderer.send("amo:notes-tray", action),
    /** 关于便签 (2026-10-30): its version, and the Studio that carries it when it has no install of its own. */
    aboutInfo: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:notes-about-info"),
    /** The title bar's right-click menu chose 关于便签. */
    onAbout: (listener: () => void): (() => void) => {
      const on = () => listener();
      electron.ipcRenderer.on("amo:notes-about", on);
      return () => electron.ipcRenderer.removeListener("amo:notes-about", on);
    },
  },
});
