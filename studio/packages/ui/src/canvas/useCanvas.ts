import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDoc } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/**
 * A topic's canvas document with optimistic saves.
 *
 * Saves from this window are queued, and an edit based on a version this window itself just replaced is rebased onto
 * the newer version (quick successive edits must not conflict with each other). A version written by another window
 * is never rebased over: that save gets a 409, the latest copy is reloaded and the conflict is reported.
 */
export function useCanvas(link: HostLink, topicId: string) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Why the last save was refused (other than a conflict); the canvas was reloaded. */
  const [error, setError] = useState("");
  const latest = useRef<CanvasDoc | null>(null);
  latest.current = doc;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** version this window saved from → version the server assigned. */
  const ownSaves = useRef(new Map<number, number>());

  const load = useCallback(() => call(link, "GET /api/topics/:id/canvas", { id: topicId }).then((d) => setDoc(d)), [link, topicId]);

  useEffect(() => {
    // Another topic: start from its own document, not the previous one's versions.
    setDoc(null);
    ownSaves.current.clear();
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "canvas.updated" && e.canvas.id === topicId && (!latest.current || latest.current.id !== topicId || e.canvas.version > latest.current.version)) setDoc(e.canvas);
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      off();
      offReconnect();
    };
  }, [load, topicId]);

  const save = useCallback(
    (next: CanvasDoc): Promise<CanvasDoc> => {
      setDoc(next); // optimistic
      const run = async () => {
        let version = next.version;
        while (ownSaves.current.has(version)) version = ownSaves.current.get(version)!;
        try {
          const saved = await call(link, "PUT /api/topics/:id/canvas", { id: topicId }, { ...next, version });
          ownSaves.current.set(version, saved.version);
          setDoc((cur) => (!cur || saved.version >= cur.version ? saved : cur));
          setConflict(false);
          setError("");
          return saved;
        } catch (err) {
          if (err instanceof HostApiError && err.status === 409) setConflict(true);
          else setError(err instanceof Error ? err.message : String(err));
          await load();
          throw err;
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result.catch(() => undefined);
      return result;
    },
    [link, load, topicId],
  );

  return { doc, save, conflict, dismissConflict: () => setConflict(false), error, dismissError: () => setError("") };
}
