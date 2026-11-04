import { useCallback, useSyncExternalStore } from "react";
import type { HostLink } from "./client.js";
import { watchLive, type LiveOptions } from "./live.js";

// One copy per window and Host of something many components read (2026-11-04, plans/cleanup-2026-11.md 第 7 步):
// useSettings was in seven components, each with its own GET /api/settings, and useProfiles in four, each loading the
// whole /api/state. Like duty/duty.ts, but started by whoever reads it first and stopped when the last one goes, so a
// window needs nothing set up. Keyed by address and token: a reconnect hands a new HostLink object for the same Host,
// and the watch reads again itself on the reconnect.

type SharedOptions<T> = Omit<LiveOptions<T | null>, "initial" | "reset" | "load"> & { load: () => Promise<T> };

interface Entry<T> {
  value: T | null;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const keyOf = (link: HostLink) => `${link.url}\n${link.token}`;

export interface SharedLive<T> {
  /** The hook: the value for this Host (null until read, and for a link without an address). */
  (link: HostLink): T | null;
  /** Outside React (and for tests): listen, which starts the watch for the first listener; the returned function stops listening. */
  subscribe(link: HostLink, listener: () => void): () => void;
  peek(link: HostLink): T | null;
}

/** A hook reading one live value per Host for the whole window. */
export function sharedLive<T>(options: (link: HostLink) => SharedOptions<T>): SharedLive<T> {
  const entries = new Map<string, Entry<T>>();
  const entryFor = (key: string): Entry<T> => {
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { value: null, listeners: new Set(), stop: null }));
    return e;
  };
  const subscribe = (link: HostLink, listener: () => void): (() => void) => {
    if (!link.url) return () => undefined;
    const e = entryFor(keyOf(link));
    e.listeners.add(listener);
    if (!e.stop) {
      const opts = options(link);
      const w = watchLive<T | null>(
        () => ({ ...opts, initial: null }),
        (next) => {
          const value = next(e.value);
          if (value === e.value) return;
          e.value = value;
          for (const l of e.listeners) l();
        },
      );
      e.stop = w.stop;
    }
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0 && e.stop) {
        // The value stays for the next reader to show at once; the watch it starts reads again.
        e.stop();
        e.stop = null;
      }
    };
  };
  const peek = (link: HostLink): T | null => (link.url ? (entries.get(keyOf(link))?.value ?? null) : null);
  function useShared(link: HostLink): T | null {
    const key = keyOf(link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const sub = useCallback((l: () => void) => subscribe(link, l), [key]);
    return useSyncExternalStore(sub, () => peek(link));
  }
  return Object.assign(useShared, { subscribe, peek });
}
