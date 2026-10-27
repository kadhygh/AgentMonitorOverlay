import { useCallback, useEffect, useRef, useState } from "react";
import { shell } from "./env.js";
import { RelayClient, type Health, type UpdateInfo } from "./shared.js";

// Updates and the service's state, for the login screen and the conversations.
//
// The loader installs a newer build at start, and the login screen applies one by itself until something is typed
// (canApply). Once signed in it is by hand (2026-10-27, the user's call: an update that applied itself while the window
// was away went unnoticed): the service says when it has a new one (/ws), the bottom left offers 「立即更新」. Applying
// reloads the page in place (the desktop shell downloads the build first; a browser just reloads /app/); what was open
// comes back (resume).

const RESUME = "amo-relay.resume";
const AUTO_CHECK_MS = 5000;

export interface Resume {
  openId: string | null;
  /** The version the update went to, to say so after the reload. */
  updatedTo?: string;
}

/** Saved just before an update reloads the page, read once after it. */
export function saveResume(r: Resume): void {
  try {
    sessionStorage.setItem(RESUME, JSON.stringify(r));
  } catch {
    // no session storage: the update still happens, the open conversation is not kept
  }
}

export function takeResume(): Resume | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(RESUME) ?? "null") as Resume | null;
    sessionStorage.removeItem(RESUME);
    return r;
  } catch {
    return null;
  }
}

/** Something typed or picked that a reload would lose, or a dialog open. */
export function pageHasDraft(): boolean {
  if (document.querySelector(".overlay, .reply-form .opt.on, .reply-form .vbtn.on")) return true;
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input:not([type=checkbox]):not([type=radio]):not([type=password])");
  return [...fields].some((f) => f.value.trim() !== "");
}

/** Not in use: in the tray, minimized, or another window in front (the desktop shell knows; a page guesses). */
export async function pageIsIdle(): Promise<boolean> {
  if (shell?.inUse) return !(await shell.inUse().catch(() => true));
  return document.hidden || !document.hasFocus();
}

/** The build a browser runs: the manifest next to /app/index.html. */
let browserVersion: Promise<string | null> | null = null;
function ownBrowserVersion(): Promise<string | null> {
  browserVersion ??= fetch("./manifest.json", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ version: string }>) : null))
    .then((m) => m?.version ?? null)
    .catch(() => null);
  return browserVersion;
}

export interface Updates {
  update: UpdateInfo | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  apply: () => Promise<void>;
}

/**
 * `latest`: the client version the service hands out, as last heard. `canApply` says whether applying now would lose
 * nothing — without it the update waits for `apply`; `beforeApply` keeps what should come back after the reload.
 */
export function useUpdates(latest: string | null, canApply: (() => boolean | Promise<boolean>) | null, beforeApply: (version: string) => void = () => undefined): Updates {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A version whose update failed is not tried again by itself (the button still can).
  const failed = useRef<string | null>(null);
  const live = useRef({ canApply, beforeApply });
  live.current = { canApply, beforeApply };

  useEffect(() => shell?.onUpdateProgress(setProgress), []);

  useEffect(() => {
    let gone = false;
    void (async () => {
      if (shell) {
        const info = await shell.info();
        if (!latest || latest === info.contentVersion) return !gone && setUpdate(info.update && info.update.latest !== info.contentVersion ? info.update : null);
        const u = await shell.checkUpdate();
        if (!gone) setUpdate(u);
      } else {
        const own = await ownBrowserVersion();
        if (!gone) setUpdate(latest && own && latest !== own ? { current: own, latest, needShell: false } : null);
      }
    })();
    return () => {
      gone = true;
    };
  }, [latest]);

  const apply = useCallback(async () => {
    if (!update) return;
    setError(null);
    setProgress({ done: 0, total: 1 });
    live.current.beforeApply(update.latest);
    if (!shell) return location.reload();
    try {
      // Resolves only if the reload did not happen; normally this page is gone by then.
      await shell.applyUpdate();
    } catch (err) {
      failed.current = update.latest;
      setProgress(null);
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    }
  }, [update]);

  useEffect(() => {
    if (!update || update.needShell || progress || !live.current.canApply) return;
    const t = setInterval(() => {
      const canApply = live.current.canApply;
      if (failed.current === update.latest || !canApply) return;
      void Promise.resolve(canApply()).then((ok) => {
        if (ok) void apply();
      });
    }, AUTO_CHECK_MS);
    return () => clearInterval(t);
  }, [update, progress, apply]);

  return { update, progress, error, apply };
}

export interface ServerStatus {
  health: Health | null;
  /** Why it cannot be reached; null while reachable or on the first try. */
  error: string | null;
  checking: boolean;
  /** Since when it has been unreachable. */
  offlineSince: number | null;
  /** The next try. */
  nextAt: number | null;
  retry: () => void;
}

const ONLINE_EVERY = 30_000;
const OFFLINE_EVERY = 5000;

/** The login screen's view of the service: /api/health now and then, every few seconds while it is unreachable. */
export function useServerStatus(server: string): ServerStatus {
  const [state, setState] = useState<Omit<ServerStatus, "retry">>({ health: null, error: null, checking: true, offlineSince: null, nextAt: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!server) return;
    let gone = false;
    const client = new RelayClient(server);
    check.current = () => {
      if (timer.current) clearTimeout(timer.current);
      setState((s) => ({ ...s, checking: true }));
      client
        .health()
        .then((health) => {
          if (gone) return;
          setState({ health, error: null, checking: false, offlineSince: null, nextAt: Date.now() + ONLINE_EVERY });
          timer.current = setTimeout(check.current, ONLINE_EVERY);
        })
        .catch((err: unknown) => {
          if (gone) return;
          const text = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, error: /fetch|network|failed/i.test(text) ? "连不上" : text, checking: false, offlineSince: s.offlineSince ?? Date.now(), nextAt: Date.now() + OFFLINE_EVERY }));
          timer.current = setTimeout(check.current, OFFLINE_EVERY);
        });
    };
    check.current();
    return () => {
      gone = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [server]);

  return { ...state, retry: useCallback(() => check.current(), []) };
}

/** Re-renders every second while `on` (countdowns). */
export function useSecondTick(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** "3 秒" / "2 分钟" / "1 小时". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时`;
}
