import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from "react";
import type { HostEvent } from "@amo-studio/protocol";
import { onHostEvent, onHostReconnect } from "./events.js";

// 「订阅事件 → GET → 合并 → 断线后重读」 in one place (2026-11-04, plans/cleanup-2026-11.md 第 7 步): it was written out
// in some 23 hooks and panels, each a little differently, a few of them never reading again after a reconnect.

export interface LiveOptions<T> {
  /** What to fetch. null (no link yet, nothing picked) fetches nothing and the value stays as it is. */
  load: (() => Promise<T>) | null;
  /** The value before the first answer (and again when the deps change, with `reset`). */
  initial: T;
  /** A Host event applied to the value: the next value, or `cur` itself to ignore it. Keep it pure. */
  onEvent?: (cur: T, event: HostEvent) => T;
  /** Events after which the whole thing is fetched again (a summary the events do not carry). */
  reloadOn?: (event: HostEvent) => boolean;
  /** Coalesces the reloads asked for by `reloadOn` (a turn updating several sessions), in ms. */
  reloadDelay?: number;
  onError?: (err: unknown) => void;
  /** Go back to `initial` when the deps change (another task, another session) instead of showing the old one meanwhile. */
  reset?: boolean;
}

export type LiveResource<T> = [value: T, set: Dispatch<SetStateAction<T>>, reload: () => void];

/**
 * The loop behind useLiveResource, without React (unit-tested on its own): loads now and again on every reconnect and
 * `reloadOn` event, applies events through `update`. An answer can arrive after events for changes it did not see yet
 * (seen with a slow first load: an item added right away vanished), so the events received while a load was out are
 * applied again on top of its answer — `onEvent` must not mind seeing an event twice (an upsert by id, a removal).
 * Only the latest load's answer counts. `options` is read anew each time, so the caller can hand the latest closures.
 */
export function watchLive<T>(options: () => LiveOptions<T>, update: (next: (cur: T) => T) => void): { reload(): void; stop(): void } {
  let live = true;
  let seq = 0;
  let missed: HostEvent[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const load = () => {
    const fetcher = options().load;
    if (!live || !fetcher) return;
    const mine = ++seq;
    missed = [];
    fetcher().then(
      (loaded) => {
        if (!live || mine !== seq) return;
        const events = missed ?? [];
        missed = null;
        const apply = options().onEvent;
        update(() => (apply ? events.reduce(apply, loaded) : loaded));
      },
      (err: unknown) => {
        if (!live || mine !== seq) return;
        missed = null;
        options().onError?.(err);
      },
    );
  };
  const off = onHostEvent((e) => {
    const { onEvent, reloadOn, reloadDelay } = options();
    if (onEvent) {
      missed?.push(e);
      update((cur) => onEvent(cur, e));
    }
    if (reloadOn?.(e)) {
      if (!reloadDelay) return load();
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, reloadDelay);
    }
  });
  const offReconnect = onHostReconnect(load);
  load();
  return {
    reload: load,
    stop() {
      live = false;
      if (timer) clearTimeout(timer);
      off();
      offReconnect();
    },
  };
}

/**
 * A value read from the Host and kept live: loaded when the deps change and again when the event socket reconnects,
 * events applied as they come (see watchLive). Returns the value, its setter (for a change's own answer) and reload.
 */
export function useLiveResource<T>(options: LiveOptions<T>, deps: DependencyList): LiveResource<T> {
  const [value, setValue] = useState<T>(options.initial);
  const latest = useRef(options);
  latest.current = options;
  const reloadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (latest.current.reset) setValue(latest.current.initial);
    if (!latest.current.load) {
      reloadRef.current = () => undefined;
      return;
    }
    const w = watchLive(() => latest.current, setValue);
    reloadRef.current = w.reload;
    return w.stop;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => reloadRef.current(), []);
  return [value, setValue, reload];
}

/** An item put in its list by id: replaced where it is, added at the end when new. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** A list of the items that pass `keep` (open decisions, unread mail): the item goes in at the end, or out. */
export function keepWhere<T extends { id: string }>(list: readonly T[], item: T, keep: boolean): T[] {
  const rest = list.filter((x) => x.id !== item.id);
  return keep ? [...rest, item] : rest;
}

/** An item taken out of its list by id. */
export function removeById<T extends { id: string }>(list: readonly T[], id: string): T[] {
  return list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : (list as T[]);
}
