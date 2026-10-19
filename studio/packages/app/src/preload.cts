// Sandboxed preload (CommonJS). Exposes only what the UI needs to reach the Host; the token never appears in
// command-line arguments or URLs.
import electron = require("electron");

/** A bookmarked passage of a reply (书签, 2026-10-19): the workbench scrolls to it and flashes it. */
type Passage = { itemId: string; start: number; end: number; quote: string };

electron.contextBridge.exposeInMainWorld("amo", {
  host: (): Promise<{ url: string; token: string } | null> => electron.ipcRenderer.invoke("amo:host"),
  pickDirectory: (start?: string | null): Promise<string | null> => electron.ipcRenderer.invoke("amo:pick-directory", start ?? undefined),
  openExternal: (url: string): Promise<void> => electron.ipcRenderer.invoke("amo:open-external", url),
  /** The page's summary of one window drag (lib/resizeTrace.ts), for logs/resize-trace.log. */
  trace: (summary: unknown): void => electron.ipcRenderer.send("amo:trace", summary),
  copyText: (text: string): Promise<void> => electron.ipcRenderer.invoke("amo:copy", text),
  /** The workbench window's own title bar buttons. */
  windowControls: {
    minimize: (): void => electron.ipcRenderer.send("amo:window", "minimize"),
    toggleMaximize: (): void => electron.ipcRenderer.send("amo:window", "maximize"),
    close: (): void => electron.ipcRenderer.send("amo:window", "close"),
    isMaximized: (): Promise<boolean> => electron.ipcRenderer.invoke("amo:window-maximized"),
    onMaximized: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: unknown, maximized: boolean) => cb(maximized);
      electron.ipcRenderer.on("amo:window-maximized", listener);
      return () => electron.ipcRenderer.removeListener("amo:window-maximized", listener);
    },
  },
  /** 置顶 (stage 14): keep the workbench window above other windows. */
  pin: {
    get: (): Promise<boolean> => electron.ipcRenderer.invoke("amo:pin-get"),
    set: (on: boolean): Promise<void> => electron.ipcRenderer.invoke("amo:pin-set", on),
    onChange: (cb: (on: boolean) => void): (() => void) => {
      const listener = (_event: unknown, on: boolean) => cb(on);
      electron.ipcRenderer.on("amo:pin-changed", listener);
      return () => electron.ipcRenderer.removeListener("amo:pin-changed", listener);
    },
  },
  /** 界面大小 (2026-10-15): the zoom of every Studio page. */
  uiScale: {
    get: (): Promise<number> => electron.ipcRenderer.invoke("amo:ui-scale-get"),
    set: (scale: number): Promise<void> => electron.ipcRenderer.invoke("amo:ui-scale-set", scale),
    onChange: (cb: (scale: number) => void): (() => void) => {
      const listener = (_event: unknown, scale: number) => cb(scale);
      electron.ipcRenderer.on("amo:ui-scale-changed", listener);
      return () => electron.ipcRenderer.removeListener("amo:ui-scale-changed", listener);
    },
  },
  /** First-run setup window of the portable build only (the handlers exist only while it is open). */
  setup: {
    info: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:setup-info"),
    pick: (): Promise<string | null> => electron.ipcRenderer.invoke("amo:setup-pick"),
    done: (dataDir: string): Promise<unknown> => electron.ipcRenderer.invoke("amo:setup-done", dataDir),
  },
  focus: {
    get: (): Promise<boolean> => electron.ipcRenderer.invoke("amo:focus-get"),
    set: (on: boolean): Promise<void> => electron.ipcRenderer.invoke("amo:focus-set", on),
    onChange: (cb: (on: boolean) => void): (() => void) => {
      const listener = (_event: unknown, on: boolean) => cb(on);
      electron.ipcRenderer.on("amo:focus-changed", listener);
      return () => electron.ipcRenderer.removeListener("amo:focus-changed", listener);
    },
    /** Focus window only: let clicks through (true) or catch them (false); used by 点击穿透. */
    setIgnoreMouse: (ignore: boolean): void => electron.ipcRenderer.send("amo:focus-mouse", ignore),
    /** Focus window only: the parts of the window that are Focus (panel, robot, settings); clicks elsewhere go through. */
    setShape: (rects: Array<{ x: number; y: number; width: number; height: number }>): void => electron.ipcRenderer.send("amo:focus-shape", rects),
    /** Focus window only: the page saw a press (a click Chromium dropped is given back otherwise; focus-clicks.ts). */
    pressed: (): void => electron.ipcRenderer.send("amo:focus-pointer"),
    /** Focus window only: the robot leaves Focus and flies about the screen saying `message` (or says it, flying). */
    fly: (message: string): void => electron.ipcRenderer.send("amo:bot-fly", message),
    /** Focus window only: the flying robot comes back. */
    land: (): void => electron.ipcRenderer.send("amo:bot-land"),
    /** Focus window only: the flying robot was clicked (it has landed). */
    onBotCaught: (cb: () => void): (() => void) => {
      const listener = () => cb();
      electron.ipcRenderer.on("amo:bot-caught", listener);
      return () => electron.ipcRenderer.removeListener("amo:bot-caught", listener);
    },
    /** Focus window only: a right-click on its title row (a drag area the page never hears about), in page pixels. */
    onContextMenu: (cb: (at: { x: number; y: number }) => void): (() => void) => {
      const listener = (_event: unknown, at: { x: number; y: number }) => cb(at);
      electron.ipcRenderer.on("amo:focus-context-menu", listener);
      return () => electron.ipcRenderer.removeListener("amo:focus-context-menu", listener);
    },
  },
  /** The flying robot's own window (#bot). */
  bot: {
    message: (): Promise<string> => electron.ipcRenderer.invoke("amo:bot-message"),
    onSay: (cb: (message: string) => void): (() => void) => {
      const listener = (_event: unknown, message: string) => cb(message);
      electron.ipcRenderer.on("amo:bot-say", listener);
      return () => electron.ipcRenderer.removeListener("amo:bot-say", listener);
    },
    setShape: (rects: Array<{ x: number; y: number; width: number; height: number }>): void => electron.ipcRenderer.send("amo:bot-shape", rects),
    pressed: (): void => electron.ipcRenderer.send("amo:focus-pointer"),
    caught: (): void => electron.ipcRenderer.send("amo:bot-caught"),
  },
  /** The scratchpad window (便签): open or bring it forward, hide it (from itself), and its global shortcut. */
  scratchpad: {
    open: (): Promise<void> => electron.ipcRenderer.invoke("amo:scratchpad-open"),
    hide: (): void => electron.ipcRenderer.send("amo:scratchpad-hide"),
    applyShortcut: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:scratchpad-shortcut-apply"),
    shortcutStatus: (): Promise<unknown> => electron.ipcRenderer.invoke("amo:scratchpad-shortcut-status"),
  },
  /**
   * The project's Git Review window (one per project), at a file when `file` is given (stage 13: 用 git diff 看), or a
   * commit's (one per commit, S13-B).
   */
  openReview: (target: { workspaceId: string; sessionId?: string; file?: string; commit?: string }): Promise<void> =>
    electron.ipcRenderer.invoke("amo:open-review", target),
  /** A commit's review window only: show another commit of the same project here. */
  switchReview: (target: { workspaceId: string; commit: string }): Promise<void> => electron.ipcRenderer.invoke("amo:switch-review", target),
  /** The viewer (查看器, stage 13): a file in the preview window (reused until 固定), at a line or range. */
  openViewer: (target: { path: string; workspaceId?: string; line?: number; endLine?: number; mode?: "file" | "changes"; sessionId?: string }): Promise<void> =>
    electron.ipcRenderer.invoke("amo:open-viewer", target),
  /** Viewer windows only: 固定 this window (the next file opens another), and whether it is. */
  pinViewer: (): Promise<boolean> => electron.ipcRenderer.invoke("amo:viewer-pin"),
  viewerState: (): Promise<{ pinned: boolean }> => electron.ipcRenderer.invoke("amo:viewer-state"),
  openInWorkbench: (target: { taskId?: string; sessionId?: string; show?: boolean; passage?: Passage }): Promise<void> => electron.ipcRenderer.invoke("amo:open-in-workbench", target),
  onNavigate: (cb: (target: { taskId: string; sessionId?: string; passage?: Passage }) => void): (() => void) => {
    const listener = (_event: unknown, target: { taskId: string; sessionId?: string; passage?: Passage }) => cb(target);
    electron.ipcRenderer.on("amo:navigate", listener);
    return () => electron.ipcRenderer.removeListener("amo:navigate", listener);
  },
  /** The real path of a dropped or picked file (File.path is gone in recent Electron); "" for in-memory files. */
  pathForFile: (file: File): string => electron.webUtils.getPathForFile(file),
  /** The Host stopped unexpectedly and the shell started it again. */
  onHostRestarted: (cb: () => void): (() => void) => {
    const listener = () => cb();
    electron.ipcRenderer.on("amo:host-restarted", listener);
    return () => electron.ipcRenderer.removeListener("amo:host-restarted", listener);
  },
  /** The file marks window (文件标记, one for all projects), showing a project first, or one mark (its note in focus). */
  openMarks: (target: { topicId?: string; workspaceId?: string; markId?: string; edit?: boolean }): Promise<void> => electron.ipcRenderer.invoke("amo:open-marks", target),
});
