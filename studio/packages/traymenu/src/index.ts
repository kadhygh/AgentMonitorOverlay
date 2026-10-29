import { BrowserWindow, nativeTheme, screen } from "electron";
import { menuHeight, menuHtml, type MenuEntry } from "./html.js";

// @amo-studio/traymenu (2026-10-29, the user: every tray menu like 便签's): the tray menu as a small frameless window in
// AMO's look instead of Windows' rounded menu, for the platform, Studio and 中转 (便签 keeps its own, the model for this
// one). Opened above the pointer on a right-click of the icon, gone on a click elsewhere or Esc, like a menu.

export { menuHeight, menuHtml, MENU_SIZES, type MenuEntry } from "./html.js";
export { badgeText } from "./badge.js";
export { badgedImage, overlayImage } from "./badge-image.js";

export class TrayMenu {
  private win: BrowserWindow | null = null;
  private entries: MenuEntry[] = [];

  /** label: the window's and the menu's name ("平台菜单"); width in px (便签's is 184). */
  constructor(private readonly options: { label: string; width?: number }) {}

  /** Shows `entries` above the pointer (the tray is at the screen's edge), kept on the display. */
  open(entries: MenuEntry[]): void {
    this.entries = entries;
    const w = (this.win ??= this.create());
    const size = { width: this.options.width ?? 184, height: menuHeight(entries) };
    const at = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(at).workArea;
    const x = Math.min(Math.max(at.x - size.width, area.x), area.x + area.width - size.width);
    const y = at.y - size.height >= area.y ? at.y - size.height : Math.min(at.y, area.y + area.height - size.height);
    w.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#181b1f" : "#fbfaf7");
    // Shown once drawn, so the old items never flash.
    w.webContents.once("did-finish-load", () => {
      if (w.isDestroyed()) return;
      // Its size is made for 100 % (Studio zooms every window it has to its 界面大小).
      w.webContents.setZoomFactor(1);
      w.setBounds({ x, y, ...size });
      w.show();
      w.focus();
    });
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(menuHtml(entries, this.options.label))}`);
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private create(): BrowserWindow {
    const w = new BrowserWindow({
      width: this.options.width ?? 184,
      height: 100,
      x: -32000,
      y: -32000,
      title: this.options.label,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.setAlwaysOnTop(true, "pop-up-menu");
    w.setMenu(null);
    // Like a menu: gone as soon as something else is clicked.
    w.on("blur", () => w.hide());
    w.on("closed", () => (this.win = null));
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const m = /^http:\/\/amo-menu\/(\w+)/.exec(url);
      if (!m) return;
      w.hide();
      const entry = m[1] === "close" ? undefined : this.entries[Number(m[1])];
      if (entry?.kind === "item") entry.run();
    });
    return w;
  }
}
