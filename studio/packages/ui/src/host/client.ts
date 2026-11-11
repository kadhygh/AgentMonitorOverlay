import type { HostErrorBody, HostRoute, RouteRequest, RouteResponse, StateSnapshot } from "@amo-studio/protocol";

// Typed client for the Host API. The Electron preload provides the Host URL and token (window.amo.host()).

/** A bookmarked passage of a reply (书签, 2026-10-19): the workbench scrolls to it and flashes it. */
export type Passage = { itemId: string; start: number; end: number; quote: string };

/** What a folder picker call answers (packages/app/src/folders.ts). */
export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: string };
/** A folder and its folders; `parent` null at a drive's root. */
export type FolderListing = { path: string; parent: string | null; folders: string[] };
/** 崩溃转储 (packages/app/src/main.ts, amo:crash-dumps-get): `running` this run, `next` the next start. */
export type CrashDumpsInfo = {
  running: boolean;
  next: { on: boolean; why: "env" | "setting" | "test-channel" | "stable-channel" | "no-platform" };
  setting: boolean | null;
  channel: "test" | "stable" | null;
  dir: string;
  count: number;
  newest: number | null;
};

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
      /** 另存为 (2026-11-11, Studio and the Reviewer): the system's save dialog, then the file written there (`bytes`, else read from `url`). */
      saveFile?(input: { name: string; bytes?: Uint8Array; url?: string }): Promise<{ saved: boolean; path?: string; error?: string }>;
      /** 复制图片 (2026-11-11, Studio and the Reviewer): the picture itself on the clipboard (`bytes` PNG or JPEG, else read from `url`). */
      copyImage?(input: { bytes?: Uint8Array; url?: string }): Promise<{ copied: boolean; width?: number; height?: number; error?: string }>;
      /** The 便签 program (2026-10-30): text and pictures together. */
      copyRich?(input: { text: string; images: Uint8Array[] }): Promise<void>;
      setMinWidth?(px: number): void;
      /** The AMO Reviewer program alone (2026-10-29): its 主题, which its main process sets for all its windows. */
      theme?(): Promise<"light" | "dark" | "system">;
      setTheme?(theme: "light" | "dark" | "system"): Promise<void>;
      /** The Focus window (Electron). */
      focus?: {
        get(): Promise<boolean>;
        set(on: boolean): Promise<void>;
        onChange(cb: (on: boolean) => void): () => void;
        setIgnoreMouse(ignore: boolean): void;
        /** Focus window: 移动位置 starts or ends (10-22); while it lasts a drag moves the window. */
        setMoving?(on: boolean): void;
        /** Focus window: 拖拽调整大小 on or off (2026-11-06); while on the window may activate. */
        setSizing?(on: boolean): void;
        /** Focus window: a drag of the resize grip starts, moves or ends (the main process follows the pointer). */
        resize?(phase: "start" | "move" | "end"): void;
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
      /** 设置 → 维护 → 崩溃转储 (2026-11-10, Electron): Crashpad minidumps of this Studio's processes. */
      crashDumps?: {
        get(): Promise<CrashDumpsInfo>;
        /** true / false: the person's choice; null: back to what the channel says. From the next start. */
        set(on: boolean | null): Promise<CrashDumpsInfo>;
        /** Opens the folder; an error message, or "" when it opened. */
        open(): Promise<string>;
      };
      /** From Focus: show a task (and session) in the workbench. */
      /** A task (and session); without a task (a topic session) the workbench shows the board; `topicId`: that topic's
       * canvas (画布审阅, 2026-10-27), opening the question `calloutId`. */
      openInWorkbench?(target: { taskId?: string; sessionId?: string; show?: boolean; passage?: Passage; topicId?: string; calloutId?: string; /** 设置 on this page (远程, 2026-10-29). */ settings?: "remote" }): Promise<void>;
      /** 在中转里打开 (2026-11-05): an AMO 中转 client Studio can find; showing a thread in it (false: none found). */
      relayAvailable?(): Promise<boolean>;
      openInRelay?(threadId: string): Promise<boolean>;
      /** 画布小窗 (2026-10-27): a topic's canvas in the small window on top. */
      openCanvasMini?(target: { topicId?: string }): Promise<void>;
      /** In the 画布小窗: keep it on top of other windows (or not); without a value, whether it is. */
      canvasMiniTop?(on?: boolean): Promise<boolean>;
      /** 计划窗口 (2026-11-09): a session's plan (its latest, or the version `itemId`) in a window of its own. */
      openPlan?(target: { sessionId: string; itemId?: string }): Promise<void>;
      /** One window drag's summary, for logs/resize-trace.log (Electron). */
      trace?(summary: unknown): void;
      windowControls?: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximized(cb: (maximized: boolean) => void): () => void;
        /** 置顶 (问题 #3): on top of other windows or not; without a value, whether it is. Absent in older preloads. */
        onTop?(on?: boolean): Promise<boolean>;
      };
      /** Workbench: Focus asked to show a task. */
      onNavigate?(cb: (target: { taskId: string; sessionId?: string; passage?: Passage; topicId?: string; calloutId?: string; settings?: "remote" }) => void): () => void;
      onHostRestarted?(cb: () => void): () => void;
      /** The 便签 program's windows (packages/notes, 2026-10-23); absent inside Studio. */
      notes?: {
        openSettings(): Promise<void>;
        closeSettings(): void;
        pickFolder(start?: string | null): Promise<string | null>;
        trayAction?(action: "show" | "todo" | "settings" | "quit" | "close"): void;
        hideTodo?(): void;
        aboutInfo?(): Promise<NotesAbout>;
        onAbout?(listener: () => void): () => void;
      };
    };
  }
}

/** 关于便签 (2026-10-30). `viaStudio`: the Studio version whose exe runs it (便签 has no install of its own), else null. */
export interface NotesAbout {
  version: string;
  dev: boolean;
  viaStudio: string | null;
  electron: string;
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
  return request<RouteResponse<R>>(link, method, `${path}${search}`, body);
}

/**
 * The one way the windows talk to a local server — the Host, or the 便签 program's own (架构整理第 7 步, 2026-11-05; Host
 * routes, attachments, 便签 and 待办 had a copy each): the bearer token, a JSON body (a Blob goes as it is, with its own
 * type), a JSON answer, and a failure as HostApiError — also when the answer is not JSON (a proxy's page, a cut-off one).
 */
export async function request<T>(link: HostLink, method: string, path: string, body?: unknown): Promise<T> {
  const raw = body instanceof Blob;
  const res = await fetch(`${link.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${link.token}`, "content-type": raw ? body.type : "application/json" },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => undefined)) as (T & Partial<HostErrorBody>) | undefined;
  if (!res.ok) throw new HostApiError(res.status, data?.error?.code ?? "internal", data?.error?.message ?? (res.statusText || `HTTP ${res.status}`));
  if (data === undefined) throw new HostApiError(res.status, "internal", "回应读不出来（不是 JSON）");
  return data;
}

export const loadState = (link: HostLink): Promise<StateSnapshot> => call(link, "GET /api/state");

/** Copies text, preferring the Electron bridge (no focus needed) over navigator.clipboard. */
export async function copyText(text: string): Promise<void> {
  if (window.amo?.copyText) return window.amo.copyText(text);
  await navigator.clipboard?.writeText(text);
}

/** Text and pictures (PNG, JPEG… bytes) together; without the 便签 program's bridge, the text and the first picture. */
export async function copyRich(text: string, images: Uint8Array<ArrayBuffer>[]): Promise<void> {
  if (!images.length) return copyText(text);
  if (window.amo?.copyRich) return window.amo.copyRich({ text, images });
  const png = new Blob([images[0]!], { type: "image/png" });
  await navigator.clipboard?.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "image/png": png })]);
}
