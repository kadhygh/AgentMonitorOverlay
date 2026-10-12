import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDoc } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/**
 * The global canvas document with optimistic saves.
 *
 * Saves from this window are queued, and an edit based on a version this window itself just replaced is rebased onto
 * the newer version (quick successive edits must not conflict with each other). A version written by another window
 * is never rebased over: that save gets a 409, the latest copy is reloaded and the conflict is reported.
 */
export function useCanvas(link: HostLink) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [conflict, setConflict] = useState(false);
  const latest = useRef<CanvasDoc | null>(null);
  latest.current = doc;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** version this window saved from → version the server assigned. */
  const ownSaves = useRef(new Map<number, number>());

  const load = useCallback(() => call(link, "GET /api/canvas").then((d) => setDoc(d)), [link]);

  useEffect(() => {
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "canvas.updated" && (!latest.current || e.canvas.version > latest.current.version)) setDoc(e.canvas);
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      off();
      offReconnect();
    };
  }, [load]);

  const save = useCallback(
    (next: CanvasDoc): Promise<CanvasDoc> => {
      setDoc(next); // optimistic
      const run = async () => {
        let version = next.version;
        while (ownSaves.current.has(version)) version = ownSaves.current.get(version)!;
        try {
          const saved = await call(link, "PUT /api/canvas", {}, { ...next, version });
          ownSaves.current.set(version, saved.version);
          setDoc((cur) => (!cur || saved.version >= cur.version ? saved : cur));
          setConflict(false);
          return saved;
        } catch (err) {
          if (err instanceof HostApiError && err.status === 409) setConflict(true);
          await load();
          throw err;
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result.catch(() => undefined);
      return result;
    },
    [link, load],
  );

  return { doc, save, conflict, dismissConflict: () => setConflict(false) };
}
