import { app, BrowserWindow } from "electron";

// Electron main process. Single instance, Host lifecycle and preload IPC land in S1-08.

function createMainWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    title: "AMO Studio",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
}

app.whenReady().then(() => {
  createMainWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
