import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDoc } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/**
 * The global canvas document with optimistic saves. `save` sends the whole document based on the version it was
 * edited from; on a version conflict it reloads the server copy and reports it.
 */
export function useCanvas(link: HostLink) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [conflict, setConflict] = useState(false);
  const latest = useRef<CanvasDoc | null>(null);
  latest.current = doc;

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
    async (next: CanvasDoc) => {
      setDoc(next); // optimistic
      try {
        const saved = await call(link, "PUT /api/canvas", {}, next);
        setDoc((cur) => (!cur || saved.version >= cur.version ? saved : cur));
        setConflict(false);
        return saved;
      } catch (err) {
        if (err instanceof HostApiError && err.status === 409) setConflict(true);
        await load();
        throw err;
      }
    },
    [link, load],
  );

  return { doc, save, conflict, dismissConflict: () => setConflict(false) };
}
