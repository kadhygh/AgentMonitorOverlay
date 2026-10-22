import { useEffect, useState } from "react";
import { pinnedFirst } from "../lib/pins.js";

/** Sidebar order is a local view preference, independent of a project's or topic's identity. */
export function useNavOrder(kind: "project" | "topic" | "sections") {
  const key = `amo.navOrder.${kind}`;
  const read = (): string[] => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
    } catch {
      return [];
    }
  };
  const [ids, setIds] = useState(read);
  useEffect(() => {
    const refresh = (e: StorageEvent) => (e.key === key || e.key === null) && setIds(read());
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    ids,
    save(next: string[]) {
      setIds(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // With storage unavailable, retain the order for this window's lifetime.
      }
    },
  };
}

/** Saved entries first, new entries in their original order; pinned and unpinned retain separate groups. */
export function navOrder<T>(items: readonly T[], ids: readonly string[], pinned: readonly string[], id: (item: T) => string): T[] {
  const ranks = new Map(ids.map((value, index) => [value, index]));
  const pins = new Set(pinned);
  return pinnedFirst(items, pinned, id).sort((a, b) => Number(pins.has(id(b))) - Number(pins.has(id(a))) || (ranks.get(id(a)) ?? Infinity) - (ranks.get(id(b)) ?? Infinity) || 0);
}

/** Moves one existing id before/after another; the complete list preserves entries hidden by folding. */
export function moveNav(ids: readonly string[], from: string, to: string, after: boolean): string[] {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return [...ids];
  const rest = ids.filter((id) => id !== from);
  const index = rest.indexOf(to) + Number(after);
  return [...rest.slice(0, index), from, ...rest.slice(index)];
}
