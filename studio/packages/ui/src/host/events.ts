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
