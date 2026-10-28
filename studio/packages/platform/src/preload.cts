// Sandboxed preload of the platform's window (CommonJS): `window.amoPlatform`, the page's only way to the main process.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("amoPlatform", {
  view: (): Promise<unknown> => electron.ipcRenderer.invoke("platform:view"),
  call: (method: string, args: unknown[]): Promise<unknown> => electron.ipcRenderer.invoke("platform:call", method, args),
  onView: (cb: (view: unknown) => void): (() => void) => {
    const listener = (_event: unknown, view: unknown) => cb(view);
    electron.ipcRenderer.on("platform:view", listener);
    return () => electron.ipcRenderer.removeListener("platform:view", listener);
  },
  /** Something the tray started could not happen (Studio without its data dir): the page says why. */
  onNotice: (cb: (notice: unknown) => void): (() => void) => {
    const listener = (_event: unknown, notice: unknown) => cb(notice);
    electron.ipcRenderer.on("platform:notice", listener);
    return () => electron.ipcRenderer.removeListener("platform:notice", listener);
  },
  /** The page's own title bar: minimise, or close to the tray. */
  windowAction: (action: "minimize" | "close"): void => electron.ipcRenderer.send("platform:window", action),
});
