import type { HostEvent } from "@amo-studio/protocol";

// In-page bus for Host events, fed by the single event socket in useHostState. Views that need session items
// (task page, chat) subscribe here instead of opening their own sockets.

type Listener = (event: HostEvent) => void;
const listeners = new Set<Listener>();

export function onHostEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitHostEvent(event: HostEvent): void {
  for (const l of listeners) l(event);
}

/** Fired when the event socket reconnects, so views reload what they may have missed. */
const reconnectListeners = new Set<() => void>();
export function onHostReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}
export function emitHostReconnect(): void {
  for (const l of reconnectListeners) l();
}

/**
 * A list's first snapshot, merged with what its event listener already received. The response can arrive after
 * events for changes the snapshot did not see yet (seen with a slow first load: an item added right away vanished), so
 * event-delivered items win and the ones the snapshot lacks are kept. On a reconnect, replace the list instead.
 */
export function mergeFirstLoad<T extends { id: string }>(loaded: readonly T[], live: readonly T[]): T[] {
  const byId = new Map(live.map((x) => [x.id, x]));
  const ids = new Set(loaded.map((x) => x.id));
  return [...loaded.map((x) => byId.get(x.id) ?? x), ...live.filter((x) => !ids.has(x.id))];
}
