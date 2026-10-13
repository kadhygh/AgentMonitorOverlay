import { useEffect, useState } from "react";

// Topics and projects pinned to the top of the left column (kept per install, shared by the windows). Pinned ones also
// come first wherever they are picked: the new-task chips, @ and # while typing, @ tasks in a conversation.

export type PinKind = "topic" | "project";
export interface Pins {
  topic: readonly string[];
  project: readonly string[];
}

const KEY = "amo.pins";
const EVENT = "amo:pins";

function read(): Pins {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Pins> | null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { topic: list(p?.topic), project: list(p?.project) };
  } catch {
    return { topic: [], project: [] };
  }
}

export function togglePin(kind: PinKind, id: string): void {
  const pins = read();
  const list = pins[kind].includes(id) ? pins[kind].filter((x) => x !== id) : [...pins[kind], id];
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...pins, [kind]: list }));
  } catch {
    // per-viewer convenience only
  }
  window.dispatchEvent(new Event(EVENT));
}

export function usePins(): Pins & { has(kind: PinKind, id: string): boolean } {
  const [pins, setPins] = useState<Pins>(read);
  useEffect(() => {
    const refresh = () => setPins(read());
    const onStorage = (e: StorageEvent) => e.key === KEY && refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return { ...pins, has: (kind, id) => pins[kind].includes(id) };
}

/** Pinned first (in pin order), the rest after in their own order. */
export function pinnedFirst<T>(items: readonly T[], pinned: readonly string[], id: (item: T) => string): T[] {
  const rank = (x: T) => {
    const i = pinned.indexOf(id(x));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return items.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
}
