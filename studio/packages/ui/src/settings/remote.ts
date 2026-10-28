import { useEffect, useState } from "react";
import type { RemoteState } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

// 远程 (2026-10-29): the Host's remote state, kept live (remote.updated is not in the event log, so a reconnect reads
// it again). 设置 → 远程, the dot beside 设置, and Focus's pairing requests all read it.

export function useRemote(link: HostLink | null): RemoteState | null {
  const [remote, setRemote] = useState<RemoteState | null>(null);
  useEffect(() => {
    if (!link?.url) return;
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/remote")
        .then((r) => !cancelled && setRemote(r))
        .catch(() => undefined);
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "remote.updated") setRemote(e.remote);
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link?.url, link?.token]); // eslint-disable-line react-hooks/exhaustive-deps -- the link by its address
  return remote;
}

/** Pairing requests waiting for an answer here: the dot beside 设置 and on the 远程 tab. */
export const remoteWaiting = (remote: RemoteState | null): number => remote?.incoming.length ?? 0;
