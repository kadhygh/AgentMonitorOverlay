import { useEffect, useState } from "react";
import { peerPresence, type RemoteGrant, type RemoteState, type Task } from "@amo-studio/protocol";
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

/**
 * What waits for the person in 设置 → 远程: the dot beside 设置 and on the 远程 tab — pairing requests and requests for
 * tasks to answer here (step 4), and refusals of this computer's requests not yet put away.
 */
export const remoteWaiting = (remote: RemoteState | null): number => (remote ? remote.incoming.length + (remote.taskRequests?.length ?? 0) + (remote.asks?.filter((r) => r.state === "refused").length ?? 0) : 0);

/**
 * Step 2 (2026-10-29), on B: how a copy of a remote task stands — `online`: its computer is reachable; `offline`: it is
 * not (or this computer is not connected), the copy is readable and nothing can be sent; `revoked`: the grant is gone.
 * `unknown` while the state is still being read (shown as usable: a send then says what is wrong).
 */
export interface CopyStatus {
  state: "online" | "offline" | "revoked" | "unknown";
  /** A's device name. */
  name: string;
  /** What the card and the page say ("A 台式机 离线", "授权已收回"). */
  label: string;
  /** Why nothing can be sent now, for the composer; null when it can. */
  blocked: string | null;
  /** Offline because this computer is not connected (rather than A being away). */
  self?: boolean;
}

export function copyStatus(task: Task, remote: RemoteState | null, now: number = Date.now()): CopyStatus | null {
  const r = task.remote;
  if (!r) return null;
  if (r.state === "revoked") return { state: "revoked", name: r.name, label: "授权已收回", blocked: `授权已收回${r.reason && r.reason !== "授权已收回" ? `（${r.reason}）` : ""}：记录还能看，不能再发消息` };
  if (!remote) return { state: "unknown", name: r.name, label: `远程 · ${r.name}`, blocked: null };
  const peer = remote.peers.find((p) => p.account === r.account && p.device === r.device && p.role === "guest");
  const online = remote.connection.state === "online" && !!peer && peerPresence(peer, now) === "online";
  if (online) return { state: "online", name: r.name, label: `远程 · ${r.name}`, blocked: null };
  const self = remote.connection.state !== "online";
  return { state: "offline", name: r.name, label: self ? "没连上服务器" : `${r.name} 离线`, blocked: `${self ? "这台电脑没连上团队服务器" : `${r.name} 离线`}，回来后再发`, self };
}

/** On A: the devices a task is granted to. */
export const grantsOf = (remote: RemoteState | null, taskId: string): RemoteGrant[] => remote?.grants.filter((g) => g.taskId === taskId) ?? [];
