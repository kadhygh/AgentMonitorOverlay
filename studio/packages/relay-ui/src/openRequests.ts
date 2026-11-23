import { useSyncExternalStore } from "react";
import { shell } from "./env.js";

// What the shell asks the content to open (2026-11-23): a notification clicked, AMO Studio's 在中转里打开 (`--open-thread`)
// and its 打开协作 (`--open=cowork:<id>`, relay-app open-arg.ts). Heard from the start, before signing in: the login page
// says one waits, and Home opens it once the lists have loaded (or says why it cannot). `cowork:<id>` / `thread:<id>`.

let pending: string | null = null;
const listeners = new Set<() => void>();
let started = false;

function got(ref: string | null | undefined): void {
  if (!ref) return;
  pending = ref;
  for (const l of listeners) l();
}

/** Listens to the shell (once). A shell with onOpen sends everything there; an older one only threads. */
export function startOpenRequests(): void {
  if (started || !shell) return;
  started = true;
  const s = shell;
  // (taken again on each one heard: the shell keeps a started-with one until it is, and a reload would open it again)
  if (s.onOpen && s.takeOpen) {
    s.onOpen((ref) => (got(ref), void s.takeOpen?.()));
    void s.takeOpen().then(got, () => undefined);
  } else {
    s.onOpenThread((id) => (got(`thread:${id}`), void s.takeOpenThread?.()));
    void s.takeOpenThread?.().then((id) => got(id && `thread:${id}`), () => undefined);
  }
}

/** The one waiting, taken: it is opened once. */
export function takeOpenRequest(): string | null {
  const p = pending;
  pending = null;
  if (p) for (const l of listeners) l();
  return p;
}

export function useOpenRequest(): string | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => pending,
  );
}
