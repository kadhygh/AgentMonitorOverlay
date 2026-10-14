import { viewerHash, type ViewerTarget } from "./logic.js";

// Opening the viewer window (查看器, stage 13), and 固定 (pin) from inside one.

type ViewerBridge = {
  openViewer?(target: Omit<ViewerTarget, "nonce">): Promise<void>;
  pinViewer?(): Promise<boolean>;
  viewerState?(): Promise<{ pinned: boolean }>;
};

const bridge = () => window.amo as ViewerBridge | undefined;

/** The browser's name for the preview tab: window.open reuses a tab of that name; a pinned tab renames itself. */
const PREVIEW_TAB = "amo-viewer";

let tabs = 0;

/**
 * Opens a file in the viewer: the preview window (reused until it is pinned) at the line or range. Outside Electron,
 * the same page in a browser tab that plays the same role.
 */
export function openViewer(target: Omit<ViewerTarget, "nonce">): void {
  const b = bridge();
  if (b?.openViewer) {
    void b.openViewer(target);
    return;
  }
  window.open(`${location.pathname}${location.search}${viewerHash({ ...target, nonce: String(Date.now()) })}`, PREVIEW_TAB);
}

/** 固定 this viewer window: the next file opens in a new one. Resolves whether it is pinned now. */
export async function pinViewer(): Promise<boolean> {
  const b = bridge();
  if (b?.pinViewer) return b.pinViewer();
  // A browser tab: take another name, so openViewer's window.open makes a new tab next time.
  window.name = `amo-viewer-pinned-${Date.now()}-${++tabs}`;
  return true;
}

export async function viewerPinned(): Promise<boolean> {
  const b = bridge();
  if (b?.viewerState) return (await b.viewerState()).pinned;
  return window.name.startsWith("amo-viewer-pinned-");
}
