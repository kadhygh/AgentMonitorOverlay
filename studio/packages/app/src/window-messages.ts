import type { BrowserWindow } from "electron";

// Electron keeps one hookWindowMessage callback per window and message: a second hook replaces the first. Focus's
// mouse messages are wanted by both the resize trace and the lost-click recovery (focus-clicks.ts), so they share
// one hook per message through here.

type Listener = (wParam: Buffer, lParam: Buffer) => void;
const hubs = new WeakMap<BrowserWindow, Map<number, Listener[]>>();

/** Calls `listener` for each `message` the window's WndProc gets (Windows only). */
export function onWindowMessage(win: BrowserWindow, message: number, listener: Listener): void {
  if (process.platform !== "win32") return;
  let hub = hubs.get(win);
  if (!hub) hubs.set(win, (hub = new Map()));
  const listeners = hub.get(message);
  if (listeners) {
    listeners.push(listener);
    return;
  }
  const list = [listener];
  hub.set(message, list);
  win.hookWindowMessage(message, (w: Buffer, l: Buffer) => {
    for (const fn of list) {
      try {
        fn(w, l);
      } catch {
        // one listener's mistake does not stop the others
      }
    }
  });
}

export const WM_MOUSEACTIVATE = 0x0021;
export const WM_LBUTTONDOWN = 0x0201;
export const WM_LBUTTONUP = 0x0202;
export const HTCLIENT = 1;
