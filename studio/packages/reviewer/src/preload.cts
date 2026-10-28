// Sandboxed preload of the AMO Reviewer program's windows (CommonJS): the `window.amo` names Studio's preload gives the
// review pages, without Studio's own (bookmarks, sessions, Focus). `app: "reviewer"` tells the pages where they are.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("amo", {
  app: "reviewer",
  host: (): Promise<{ url: string; token: string } | null> => electron.ipcRenderer.invoke("amo:host"),
  copyText: (text: string): Promise<void> => electron.ipcRenderer.invoke("amo:copy", text),
  openExternal: (url: string): Promise<void> => electron.ipcRenderer.invoke("amo:open-external", url),
  setMinWidth: (px: number): void => electron.ipcRenderer.send("amo:min-width", px),
  openReview: (target: { workspaceId: string; sessionId?: string; file?: string; commit?: string }): Promise<void> => electron.ipcRenderer.invoke("amo:open-review", target),
  switchReview: (target: { workspaceId: string; commit: string }): Promise<void> => electron.ipcRenderer.invoke("amo:switch-review", target),
  openViewer: (target: { path: string; pack?: string; item?: string; workspaceId?: string; line?: number; endLine?: number; mode?: "file" | "changes"; remote?: string; cwd?: string }): Promise<void> =>
    electron.ipcRenderer.invoke("amo:open-viewer", target),
  pinViewer: (): Promise<boolean> => electron.ipcRenderer.invoke("amo:viewer-pin"),
  viewerState: (): Promise<{ pinned: boolean }> => electron.ipcRenderer.invoke("amo:viewer-state"),
});
