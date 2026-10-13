import { useEffect, useSyncExternalStore } from "react";
import { MAX_EXISTS_PATHS, type ExistingPath } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

// Whether the files a conversation names exist (stage 12, S12-C). Names are asked in batches (one request per
// project and working directory every few milliseconds) and remembered for the window: found ones for good, missing
// ones for a while (an agent may create the file later).

/** Where relative names start: the project, or a tool call's working directory. */
export interface ExistsBase {
  workspaceId: string | null;
  cwd?: string | undefined;
}

const MISSING_TTL_MS = 20_000;
const BATCH_DELAY_MS = 30;

interface Entry {
  value: ExistingPath | null;
  at: number;
}

const cache = new Map<string, Entry>();
const asking = new Set<string>();
const queue = new Map<string, { link: HostLink; base: ExistsBase; paths: Set<string> }>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const baseKey = (b: ExistsBase) => `${b.workspaceId ?? ""}\u0000${b.cwd ?? ""}`;
const keyOf = (b: ExistsBase, path: string) => `${baseKey(b)}\u0000${path}`;

function changed() {
  for (const l of listeners) l();
}

function fresh(e: Entry | undefined): boolean {
  return !!e && (e.value !== null || Date.now() - e.at < MISSING_TTL_MS);
}

function ask(link: HostLink, base: ExistsBase, path: string) {
  const key = keyOf(base, path);
  if (asking.has(key) || fresh(cache.get(key))) return;
  asking.add(key);
  const bk = `${link.url}\u0000${baseKey(base)}`;
  let q = queue.get(bk);
  if (!q) {
    q = { link, base, paths: new Set() };
    queue.set(bk, q);
  }
  q.paths.add(path);
  timer ??= setTimeout(flush, BATCH_DELAY_MS);
}

function flush() {
  timer = null;
  const batches = [...queue.values()];
  queue.clear();
  for (const { link, base, paths } of batches) {
    const all = [...paths];
    for (let i = 0; i < all.length; i += MAX_EXISTS_PATHS) {
      const chunk = all.slice(i, i + MAX_EXISTS_PATHS);
      const body = { paths: chunk, ...(base.workspaceId ? { workspaceId: base.workspaceId } : {}), ...(base.cwd ? { cwd: base.cwd } : {}) };
      void call(link, "POST /api/fs/exists", {}, body)
        .then((r) => {
          const at = Date.now();
          for (const p of chunk) cache.set(keyOf(base, p), { value: r.found[p] ?? null, at });
        })
        .catch(() => {
          const at = Date.now();
          for (const p of chunk) cache.set(keyOf(base, p), { value: null, at });
        })
        .finally(() => {
          for (const p of chunk) asking.delete(keyOf(base, p));
          changed();
        });
    }
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Where a named file is: its absolute path once the Host found it, null when there is nothing there, undefined while
 * asking (or with no link / no name).
 */
export function useExistingPath(link: HostLink | null, base: ExistsBase, path: string | null): ExistingPath | null | undefined {
  const key = path ? keyOf(base, path) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? cache.get(key) : undefined));
  useEffect(() => {
    if (link?.url && path && !fresh(cache.get(keyOf(base, path)))) ask(link, base, path);
  });
  if (!key) return undefined;
  return entry?.value;
}
