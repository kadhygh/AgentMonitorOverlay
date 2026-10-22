import { useCallback, useEffect, useState } from "react";

// A list of ids kept per machine in localStorage, followed across windows: what Focus pins and opens (2026-10-21), the
// sessions folded in a task's session tree (10-22).

export function readIds(key: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // no storage: kept as long as the window
  }
}

/** A list of ids kept under `key`: whether one is in it, and putting it in or taking it out (first-come order). */
export function useStoredIds(key: string): { ids: readonly string[]; has(id: string): boolean; toggle(id: string): void; keepOnly(live: ReadonlySet<string>): void } {
  const [ids, setIds] = useState<string[]>(() => readIds(key));
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) setIds(readIds(key));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  const update = useCallback(
    (f: (cur: string[]) => string[]) =>
      setIds((cur) => {
        const next = f(cur);
        if (next.length === cur.length && next.every((x, i) => x === cur[i])) return cur;
        writeIds(key, next);
        return next;
      }),
    [key],
  );
  return {
    ids,
    has: (id) => ids.includes(id),
    toggle: (id) => update((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])),
    keepOnly: (live) => update((cur) => cur.filter((x) => live.has(x))),
  };
}
