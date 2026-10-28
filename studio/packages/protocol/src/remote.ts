// 远程 (plans/remote-session.md, step 1, 2026-10-29): this computer as a device on the team server, the devices paired
// with it, and pairing requests. The Host keeps the connection (features/remote/); 设置 → 远程 and Focus show this.
// Needs the AMO platform's login (%APPDATA%\AMO\account.json): Studio has no login of its own.

import type { Timestamp } from "./entities.js";

/**
 * off: the Host was started without remote (tests, the Reviewer); no-account: nobody logged in in the AMO platform;
 * connecting / online / offline (retrying at retryAt); unauthorized: the server no longer takes the login;
 * server-old: the team server has no devices channel yet; replaced: another program connected as this device.
 */
export type RemoteConnectionState = "off" | "no-account" | "connecting" | "online" | "offline" | "unauthorized" | "server-old" | "replaced";

export interface RemoteConnection {
  state: RemoteConnectionState;
  /** What went wrong, for the person (offline, unauthorized, server-old, replaced). */
  message: string | null;
  /** When the next attempt is due (offline). */
  retryAt: Timestamp | null;
  /** Since when it is online. */
  since: Timestamp | null;
}

export interface RemoteDevice {
  id: string;
  name: string;
}

/** A paired device. */
export interface RemotePeer {
  account: string;
  device: string;
  name: string;
  /** "owner": this computer allowed it (it may reach this one); "guest": it allowed this computer. */
  role: "owner" | "guest";
  pairedAt: Timestamp;
  /** null: not known (this computer is not connected to the server). */
  online: boolean | null;
  /** When it was last connected, as far as the server knows; null when it has not seen it. */
  lastSeen: Timestamp | null;
}

/** Someone asks to pair with this computer. */
export interface RemoteIncomingRequest {
  id: string;
  account: string;
  device: string;
  name: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** A request this computer sent. Allowed ones become a peer and leave this list. */
export interface RemoteOutgoingRequest {
  id: string;
  to: string;
  state: "pending" | "refused";
  /** The device that refused it. */
  answeredBy: string | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface RemoteState {
  /** This computer (device.json); null until the Host made it (it does when it starts remote). */
  device: RemoteDevice | null;
  /** The AMO platform's login, without the key. */
  account: { server: string; name: string } | null;
  connection: RemoteConnection;
  peers: RemotePeer[];
  incoming: RemoteIncomingRequest[];
  outgoing: RemoteOutgoingRequest[];
}

export interface RemotePingResult {
  ok: boolean;
  /** Round trip, when it came back. */
  ms: number | null;
  message: string;
}

/** 刚失联 lasts this long after a device went away; then it is 离线 (Multica's two levels, plans/remote-session.md). */
export const REMOTE_LOST_MS = 5 * 60_000;

export type PeerPresence = "online" | "lost" | "offline" | "unknown";

export const PEER_PRESENCE_LABEL: Record<PeerPresence, string> = { online: "在线", lost: "刚失联", offline: "离线", unknown: "不知道（这台电脑没连上服务器）" };

export function peerPresence(peer: Pick<RemotePeer, "online" | "lastSeen">, now: number = Date.now()): PeerPresence {
  if (peer.online === null) return "unknown";
  if (peer.online) return "online";
  if (peer.lastSeen && now - Date.parse(peer.lastSeen) < REMOTE_LOST_MS) return "lost";
  return "offline";
}
