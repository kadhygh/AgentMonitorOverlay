import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectHost, stopHost, type HostConnection } from "./host-link.js";

// Electron main process: single instance, connects to (or starts) the resident Host, and opens the workbench window.
// Env:
//   AMO_STUDIO_DATA_DIR   data dir (default studio/.data)
//   AMO_STUDIO_DEV_URL    load the UI from the Vite dev server instead of the Host
//   AMO_STUDIO_TEST=1     test mode: hidden window that never takes focus, Host stops with the app
//   AMO_STUDIO_PORT       Host port (tests use 0)

const here = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(here, "..", "..", "..");
const testMode = process.env.AMO_STUDIO_TEST === "1";
const dataDir = process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data");

let host: HostConnection | null = null;
let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // A user launched Studio again: bring the existing window forward (never happens in tests).
    if (mainWindow && !testMode) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.handle("amo:host", () => (host ? { url: host.url, token: host.token } : null));
  ipcMain.handle("amo:pick-directory", async () => {
    const options = { title: "选择工作区文件夹", properties: ["openDirectory" as const] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  app
    .whenReady()
    .then(async () => {
      host = await connectHost({
        dataDir,
        hostBin: join(studioRoot, "packages", "host", "dist", "bin.js"),
        uiDir: join(studioRoot, "packages", "ui", "dist"),
        ...(process.env.AMO_STUDIO_PORT !== undefined ? { port: Number(process.env.AMO_STUDIO_PORT) } : {}),
        attached: testMode,
      });
      mainWindow = createMainWindow(host);
    })
    .catch((err: unknown) => {
      console.error("AMO Studio failed to start:", err);
      app.exit(1);
    });

  app.on("window-all-closed", () => app.quit());

  let quitting = false;
  app.on("before-quit", (event) => {
    // The Host is resident; only a Host this shell attached (tests) stops with the app.
    if (quitting || !host?.child || !testMode) return;
    event.preventDefault();
    quitting = true;
    void stopHost(host).finally(() => app.quit());
  });
}

function createMainWindow(conn: HostConnection): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "AMO Studio",
    backgroundColor: "#111316",
    // Test windows sit off-screen, out of the taskbar, and are shown without activation so they keep painting for
    // capturePage but never take focus (LOOP_RULES red line 7).
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !testMode,
    },
  });
  // The workbench never opens other windows or navigates away from the Host / dev server origin.
  const allowedOrigin = new URL(process.env.AMO_STUDIO_DEV_URL ?? conn.url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (testMode) win.showInactive();
    else win.show();
  });
  void win.loadURL(process.env.AMO_STUDIO_DEV_URL ?? `${conn.url}/`);
  return win;
}
