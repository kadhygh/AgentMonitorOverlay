import type { HostErrorBody, HostRoute, RouteRequest, RouteResponse, StateSnapshot } from "@amo-studio/protocol";

// Typed client for the Host API. The Electron preload provides the Host URL and token (window.amo.host()).

declare global {
  interface Window {
    amo?: {
      host(): Promise<{ url: string; token: string } | null>;
      /** Native folder picker (Electron); absent in a plain browser. */
      pickDirectory?(): Promise<string | null>;
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
      };
      /** From Focus: show a task (and session) in the workbench. */
      openInWorkbench?(target: { taskId: string; sessionId?: string }): Promise<void>;
      /** Workbench: Focus asked to show a task. */
      onNavigate?(cb: (target: { taskId: string; sessionId?: string }) => void): () => void;
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
