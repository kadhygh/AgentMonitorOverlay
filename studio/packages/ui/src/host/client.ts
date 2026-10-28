import type { HostErrorBody, HostRoute, RouteRequest, RouteResponse, StateSnapshot } from "@amo-studio/protocol";

// Typed client for the Host API. The Electron preload provides the Host URL and token (window.amo.host()).

/** A bookmarked passage of a reply (书签, 2026-10-19): the workbench scrolls to it and flashes it. */
export type Passage = { itemId: string; start: number; end: number; quote: string };

/** What a folder picker call answers (packages/app/src/folders.ts). */
export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: string };
/** A folder and its folders; `parent` null at a drive's root. */
export type FolderListing = { path: string; parent: string | null; folders: string[] };

declare global {
  interface Window {
    amo?: {
      host(): Promise<{ url: string; token: string } | null>;
      /** Native folder picker (Electron); absent in a plain browser. */
      /** Starts at `start` (设置 → 默认路径) when that folder exists. */
      pickDirectory?(start?: string | null): Promise<string | null>;
      /** Studio's own folder picker's calls (Electron, 2026-10-25): this machine's disks only. */
      folders?: {
        drives(refresh?: boolean): Promise<FolderResult<string[]>>;
        list(path: string): Promise<FolderResult<FolderListing>>;
        create(parent: string, name: string): Promise<FolderResult<string>>;
        rename(path: string, name: string): Promise<FolderResult<string>>;
      };
      /** Opens an http(s) link in the system browser (Electron); absent in a plain browser. */
      openExternal?(url: string): Promise<void>;
      /** The workbench window's icon (taskbar): one of 「AMO 娘」's faces by file name (focus/mascot.ts), or null for the app's. */
      setAppIcon?(face: string | null): void;
      /** Writes text to the system clipboard (Electron); works without window focus. */
      copyText?(text: string): Promise<void>;
      setMinWidth?(px: number): void;
      /** The Focus window (Electron). */
      focus?: {
        get(): Promise<boolean>;
        set(on: boolean): Promise<void>;
        onChange(cb: (on: boolean) => void): () => void;
        setIgnoreMouse(ignore: boolean): void;
        /** Focus window: 移动位置 starts or ends (10-22); while it lasts a drag moves the window. */
        setMoving?(on: boolean): void;
        /** Focus window: the parts of the window that take clicks (2026-10-15); the rest lets them through. */
        setShape?(rects: Array<{ x: number; y: number; width: number; height: number }>): void;
        /** Focus window: a right-click on its title row, passed on by the main process (S14-J). */
        pressed?(): void;
        /** Focus window: the robot flies about the screen saying `message`; `land` calls it back (2026-10-15). */
        fly?(message: string): void;
        land?(): void;
        /** 主窗口回到屏幕中央 (2026-10-19): the main window in the middle of the display Focus is on, in front. */
        centerMain?(): Promise<void>;
        onBotCaught?(cb: () => void): () => void;
        onContextMenu?(cb: (at: { x: number; y: number }) => void): () => void;
      };
      /** The flying robot's own window (#bot). */
      bot?: {
        message(): Promise<string>;
        onSay(cb: (message: string) => void): () => void;
        setShape(rects: Array<{ x: number; y: number; width: number; height: number }>): void;
        pressed(): void;
        caught(): void;
      };
      /** 界面大小 (2026-10-15): the zoom of every Studio page (Electron). */
      uiScale?: {
        get(): Promise<number>;
        set(scale: number): Promise<void>;
        onChange(cb: (scale: number) => void): () => void;
      };
      /** 置顶 (stage 14): the workbench window above other windows (Electron). */
      pin?: {
        get(): Promise<boolean>;
        set(on: boolean): Promise<void>;
        onChange(cb: (on: boolean) => void): () => void;
      };
      /** From Focus: show a task (and session) in the workbench. */
      /** A task (and session); without a task (a topic session) the workbench shows the board; `topicId`: that topic's
       * canvas (画布审阅, 2026-10-27), opening the question `calloutId`. */
      openInWorkbench?(target: { taskId?: string; sessionId?: string; show?: boolean; passage?: Passage; topicId?: string; calloutId?: string; /** 设置 on this page (远程, 2026-10-29). */ settings?: "remote" }): Promise<void>;
      /** 画布小窗 (2026-10-27): a topic's canvas in the small window on top. */
      openCanvasMini?(target: { topicId?: string }): Promise<void>;
      /** In the 画布小窗: keep it on top of other windows (or not); without a value, whether it is. */
      canvasMiniTop?(on?: boolean): Promise<boolean>;
      /** One window drag's summary, for logs/resize-trace.log (Electron). */
      trace?(summary: unknown): void;
      windowControls?: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximized(cb: (maximized: boolean) => void): () => void;
      };
      /** Workbench: Focus asked to show a task. */
      onNavigate?(cb: (target: { taskId: string; sessionId?: string; passage?: Passage; topicId?: string; calloutId?: string; settings?: "remote" }) => void): () => void;
      onHostRestarted?(cb: () => void): () => void;
      /** The 便签 program's windows (packages/notes, 2026-10-23); absent inside Studio. */
      notes?: {
        openSettings(): Promise<void>;
        closeSettings(): void;
        pickFolder(start?: string | null): Promise<string | null>;
        trayAction?(action: "show" | "settings" | "quit" | "close"): void;
      };
    };
  }
}

export interface HostLink {
  url: string;
  token: string;
}

export async function discoverHost(): Promise<HostLink | null> {
  return (await window.amo?.host()) ?? null;
}

export class HostApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HostApiError";
  }
}

/** Calls a route by its `"METHOD /path"` key; `:id`-style segments are filled from `params`. */
export async function call<R extends HostRoute>(
  link: HostLink,
  route: R,
  params: Record<string, string> = {},
  body?: RouteRequest<R>,
  query?: Record<string, string>,
): Promise<RouteResponse<R>> {
  const [method, pattern] = route.split(" ") as [string, string];
  const path = pattern.replace(/:([A-Za-z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
  const search = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await fetch(`${link.url}${path}${search}`, {
    method,
    headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as RouteResponse<R> | HostErrorBody;
  if (!res.ok) {
    const err = (data as HostErrorBody).error;
    throw new HostApiError(res.status, err?.code ?? "internal", err?.message ?? res.statusText);
  }
  return data as RouteResponse<R>;
}

export const loadState = (link: HostLink): Promise<StateSnapshot> => call(link, "GET /api/state");

/** Copies text, preferring the Electron bridge (no focus needed) over navigator.clipboard. */
export async function copyText(text: string): Promise<void> {
  if (window.amo?.copyText) return window.amo.copyText(text);
  await navigator.clipboard?.writeText(text);
}
