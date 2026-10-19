import type { HostErrorBody, HostRoute, RouteRequest, RouteResponse, StateSnapshot } from "@amo-studio/protocol";

// Typed client for the Host API. The Electron preload provides the Host URL and token (window.amo.host()).

/** A bookmarked passage of a reply (书签, 2026-10-19): the workbench scrolls to it and flashes it. */
export type Passage = { itemId: string; start: number; end: number; quote: string };

declare global {
  interface Window {
    amo?: {
      host(): Promise<{ url: string; token: string } | null>;
      /** Native folder picker (Electron); absent in a plain browser. */
      /** Starts at `start` (设置 → 默认路径) when that folder exists. */
      pickDirectory?(start?: string | null): Promise<string | null>;
      /** Opens an http(s) link in the system browser (Electron); absent in a plain browser. */
      openExternal?(url: string): Promise<void>;
      /** Writes text to the system clipboard (Electron); works without window focus. */
      copyText?(text: string): Promise<void>;
      /** The Focus window (Electron). */
      focus?: {
        get(): Promise<boolean>;
        set(on: boolean): Promise<void>;
        onChange(cb: (on: boolean) => void): () => void;
        setIgnoreMouse(ignore: boolean): void;
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
      /** A task (and session); without a task (a topic session) the workbench shows the board. */
      openInWorkbench?(target: { taskId?: string; sessionId?: string; show?: boolean; passage?: Passage }): Promise<void>;
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
      onNavigate?(cb: (target: { taskId: string; sessionId?: string; passage?: Passage }) => void): () => void;
      onHostRestarted?(cb: () => void): () => void;
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
