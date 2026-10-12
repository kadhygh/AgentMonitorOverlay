import { useCallback, useEffect, useState } from "react";
import type { PackDocContent, WorkspacePack } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

/** The extension packs of some workspaces, read on demand (no file watching): `reload` reads them again. */
export function usePacks(link: HostLink, workspaceIds: readonly string[]) {
  const key = workspaceIds.join(",");
  const [packs, setPacks] = useState<ReadonlyArray<WorkspacePack & { workspaceId: string }>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(key ? key.split(",").map((id) => call(link, "GET /api/workspaces/:id/packs", { id }).then((list) => list.map((p) => ({ ...p, workspaceId: id })))) : [])
      .then((lists) => {
        if (cancelled) return;
        setPacks(lists.flat());
        setError("");
      })
      .catch((err) => !cancelled && setError(err instanceof HostApiError ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [link, key, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  return { packs, error, loading, reload };
}

/** One pack document; null while loading or when nothing is selected. */
export function usePackDoc(link: HostLink, target: { workspaceId: string; pack: string; doc: string } | null) {
  const [doc, setDoc] = useState<PackDocContent | null>(null);
  const [error, setError] = useState("");
  const key = target ? `${target.workspaceId}/${target.pack}/${target.doc}` : "";
  useEffect(() => {
    setDoc(null);
    setError("");
    if (!target) return;
    let cancelled = false;
    call(link, "GET /api/workspaces/:id/packs/:pack/docs/:doc", { id: target.workspaceId, pack: target.pack, doc: target.doc })
      .then((d) => !cancelled && setDoc(d))
      .catch((err) => !cancelled && setError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [link, key]);
  return { doc, error };
}
