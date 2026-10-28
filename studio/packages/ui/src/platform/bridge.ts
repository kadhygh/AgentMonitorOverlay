import type { OpenResult, PlatformCalls, PlatformView } from "../../../platform/src/view.js";

// The AMO 平台 window's way to its main process (packages/platform/src/preload.cts → window.amoPlatform).

export type { OpenResult, PlatformView, ToolView, TaskView, Channel, RegisterResult, ServerCheck } from "../../../platform/src/view.js";
export type { EnvironmentView, EnvItemView } from "../../../platform/src/environment-view.js";

export interface PlatformNotice {
  tool: string;
  ok: false;
  reason: string;
  message: string;
}

interface Bridge {
  view(): Promise<PlatformView>;
  call(method: string, args: unknown[]): Promise<unknown>;
  onView(cb: (view: PlatformView) => void): () => void;
  onNotice(cb: (notice: PlatformNotice) => void): () => void;
  windowAction(action: "minimize" | "close"): void;
}

declare global {
  interface Window {
    amoPlatform?: Bridge;
  }
}

export const bridge = (): Bridge | null => window.amoPlatform ?? null;

/** platform.call("install", "studio") → the main process's Platform.install("studio"). */
export function call<K extends keyof PlatformCalls>(method: K, ...args: Parameters<PlatformCalls[K]>): Promise<Awaited<ReturnType<PlatformCalls[K]>>> {
  const b = bridge();
  if (!b) return Promise.reject(new Error("不在 AMO 平台里"));
  return b.call(method, args) as Promise<Awaited<ReturnType<PlatformCalls[K]>>>;
}

export const openTool = (tool: string) => call("open", tool) as Promise<OpenResult>;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const serverLabel = (server: string) => server.replace(/^http:\/\//i, "");
