// Devices on the team server (plans/remote-session.md, step 1, 2026-10-29): what the relay service and the programs that
// connect as a device (Studio's Host) share. A device is one computer of one account (`account` + `device`, the id from
// %APPDATA%\AMO\device.json). Two devices pair — B asks by account name, a device of that account allows — and the
// service then passes frames between exactly those two, without reading what is in them. It keeps the least it can:
// who is online (memory), the pairing requests not dealt with (7 days), and its copy of the pairs to check forwarding
// against. The pairs' own record is on the allowing side (A's Host): it decides who may reach it.
//
// HTTP, all with the account's key (Authorization: Bearer), the device's id in the body or `?device=`:
//   POST   /api/devices/pair                    {device, deviceName, to, toDevice?} → {request}   B asks account `to`
//                                                (toDevice: only that device of it sees and answers the request)
//   GET    /api/devices/pair?device=…                                            → {incoming, outgoing}
//   GET    /api/devices/online?device=…                                          → {devices}   the account's other online devices
//   POST   /api/devices/pair/<id>/answer        {device, deviceName, allow}      → {request, pair?}
//   DELETE /api/devices/pair/<id>?device=…      B withdraws its request, or puts away an answer it has seen
//   GET    /api/devices/pairs?device=…                                           → {pairs}
//   POST   /api/devices/unpair                  {device, peerAccount, peerDevice} → {ok, removed}
// WebSocket /api/devices/ws?device=…&name=… (key in the header or ?key=): pushes DeviceEvent, takes DeviceFrame. The
// service pings every 15 s and drops a socket that has not answered for 60 s; the device does the same the other way.

export const DEVICE_CHANNEL_VERSION = 1;
/** How long a pairing request, or an answer B has not seen, is kept. */
export const PAIR_REQUEST_DAYS = 7;
/** Biggest frame the service passes on. */
export const MAX_DEVICE_FRAME = 1024 * 1024;
/** A device id (account/src/device.ts makes them `d_` + 24 hex). */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** A frame's kind: what it is to the two devices (`ping`, `pong`, later the remote calls). */
export const FRAME_KIND_RE = /^[a-z][a-z0-9._-]{0,39}$/;
/** A command id, chosen by the sender. */
export const FRAME_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Close code when the same device connects again (another socket of it, e.g. a second Studio on the same AMO_HOME). */
export const CLOSE_REPLACED = 4001;

export interface DeviceRef {
  account: string;
  device: string;
}

export interface NamedDevice extends DeviceRef {
  name: string;
}

export type PairRequestState = "pending" | "allowed" | "refused";

export interface PairRequest {
  id: string;
  /** Who asks (B). */
  from: NamedDevice;
  /** The account asked (A); any of its devices may answer, unless `toDevice` names one. */
  to: string;
  /**
   * 2026-10-29 (远程页的配对弹窗): the one device of `to` asked, picked from its online devices (GET /api/devices/online);
   * only it sees the request and may answer. null: any device of the account (asked by account name).
   */
  toDevice: { device: string; name: string } | null;
  state: PairRequestState;
  /** The device that answered, once answered. */
  answeredBy: NamedDevice | null;
  createdAt: number;
  /** After this it is gone (pending: unanswered; answered: B did not come to see it). */
  expiresAt: number;
}

/** Another device of the asking device's own account that is connected now (GET /api/devices/online). */
export interface OnlineDevice {
  device: string;
  name: string;
  /** When its socket opened (ms). */
  since: number;
}

/** A pair as one of its devices sees it. */
export interface PeerView {
  peer: NamedDevice;
  /** "owner": this device allowed the peer (it is A); "guest": the peer allowed this device. */
  role: "owner" | "guest";
  pairedAt: number;
  online: boolean;
  /** ms since the peer was last connected (0 while online); null when the service has not seen it since it started. */
  ago: number | null;
}

/** Device → service. */
export type DeviceFrame =
  /** To pass to a paired device. `re`: the id of the frame this answers. `body`: anything, passed on as it is. */
  | { type: "relay"; to: DeviceRef; id: string; kind: string; re?: string; body?: unknown }
  /** This device's new name (renamed while connected). */
  | { type: "name"; name: string };

/** Service → device. */
export type DeviceEvent =
  | { type: "hello"; me: NamedDevice; version: typeof DEVICE_CHANNEL_VERSION }
  /** A frame from a paired device. */
  | { type: "relay"; from: DeviceRef; to: DeviceRef; id: string; kind: string; re?: string; body?: unknown }
  /** A frame of this device's could not be passed on: `id` is its id. */
  | { type: "relay-error"; id: string; to: DeviceRef | null; code: "not_paired" | "offline" | "bad_frame"; message: string }
  /** Someone asks this device's account to pair (to every device of it but the asking one, or only to `toDevice`). */
  | { type: "pair-request"; request: PairRequest }
  /** A request to this account was answered by another of its devices, withdrawn, or expired. */
  | { type: "pair-request-closed"; requestId: string }
  /** This device's request was answered. */
  | { type: "pair-answered"; request: PairRequest }
  /** The peer ended the pairing (or it was ended from this device's other socket). */
  | { type: "unpaired"; peer: DeviceRef }
  /** A paired device came online, went away, or was renamed. */
  | { type: "presence"; peer: NamedDevice; online: boolean; ago: number | null };
