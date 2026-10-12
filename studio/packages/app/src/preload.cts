// Sandboxed preload (CommonJS). Exposes only what the UI needs to reach the Host; the token never appears in
// command-line arguments or URLs.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("amo", {
  host: (): Promise<{ url: string; token: string } | null> => electron.ipcRenderer.invoke("amo:host"),
});
