// 传文件 (2026-11-23, plans/relay-file-transfer.md 第 2 项): files and folders from one desktop client to chosen devices of
// chosen people (one's own other devices too), through the relay service. The sender only lists what it sends; once a
// target device accepts, the sender uploads in chunks the service writes to disk (a break goes on from where the
// service is), and each receiver downloads a file as soon as it is complete there (HTTP Range, into a .part, checked
// with sha256). The service keeps the content one day at most. What the service, the content (relay-ui) and the desktop
// shell (relay-app, which does the reading and writing on disk) share.

/** One send through the service: 2 GB at most (the user, 2026-11-10; a LAN direct send later may allow more). */
export const TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Upload and download go in pieces of this size (the last piece of a file is shorter). */
export const TRANSFER_CHUNK = 8 * 1024 * 1024;
/** The service keeps a send's content this long from when it was made (the user, 2026-11-10: 1 天). */
export const TRANSFER_KEEP_MS = 24 * 60 * 60_000;
/** A record stays in the lists this long after it ended (done, cancelled, expired), then is dropped. */
export const TRANSFER_RECORD_DAYS = 7;
/** Files in one send (a folder with more is refused: zip it). */
export const TRANSFER_MAX_FILES = 10_000;
/** Devices that used the desktop client this recently are offered to send to. */
export const TRANSFER_DEVICE_DAYS = 30;
/** People × devices in one send. */
export const TRANSFER_MAX_TARGETS = 50;
/** A path in a send: segments joined by "/", each a name Windows takes. */
export const TRANSFER_PATH_MAX = 1024;

/** What is sent: a file by its path inside the send ("Assets/ui/a.png", or just "a.png"). */
export interface TransferEntry {
  path: string;
  size: number;
}

export interface TransferFile extends TransferEntry {
  index: number;
  /** Bytes the service has of it. */
  received: number;
  /** Given by the sender with its first piece; checked once the file is complete. */
  sha256: string | null;
  /** Complete on the service and its sha256 checked: receivers may download it. */
  done: boolean;
}

/** pending: waits for the person to accept on that device; accepted: downloading there; done: all of it saved there. */
export type TransferTargetState = "pending" | "accepted" | "declined" | "done";

export interface TransferTarget {
  account: string;
  device: string;
  /** The device's name when it was chosen. */
  deviceName: string;
  state: TransferTargetState;
  answeredAt: number | null;
  /** Bytes saved on that device so far (it reports as it goes). */
  got: number;
  doneAt: number | null;
}

/** open: going on; done: every target saved it or declined; cancelled by the sender; expired: a day passed. */
export type TransferState = "open" | "done" | "cancelled" | "expired";

export interface Transfer {
  id: string;
  from: string;
  fromDevice: string;
  fromDeviceName: string;
  /** The top-level names, as picked (files and folders). */
  roots: string[];
  /** Folders that have nothing in them (made on the receiving side too). */
  dirs: string[];
  files: TransferFile[];
  totalSize: number;
  targets: TransferTarget[];
  state: TransferState;
  createdAt: number;
  /** The content goes at this time unless every target ended before. */
  expiresAt: number;
  endedAt: number | null;
}

/** A device that used the desktop client: offered to send to. */
export interface RelayDevice {
  account: string;
  id: string;
  name: string;
  online: boolean;
  lastSeen: number;
}

export interface NewTransfer {
  /** The sending device (its device.json). */
  device: string;
  deviceName: string;
  entries: TransferEntry[];
  dirs?: string[];
  targets: Array<{ account: string; device: string }>;
}

/** Characters Windows does not take in a name, and control characters. */
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/** Why this path will not do, or null. Folder separators are "/"; no "." or ".." segments, no name Windows refuses. */
export function transferPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "路径不能为空";
  if (path.length > TRANSFER_PATH_MAX) return `路径太长：${path.slice(0, 60)}…`;
  for (const seg of path.split("/")) {
    if (!seg) return `路径不对：${path}`;
    if (seg === "." || seg === "..") return `路径里不能有 . 或 ..：${path}`;
    if (seg.length > 255) return `名字太长：${seg.slice(0, 60)}…`;
    if (BAD_NAME.test(seg)) return `名字里有 Windows 不认的字符：${seg}`;
    if (/[ .]$/.test(seg)) return `名字不能以空格或点结尾：${seg}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(seg)) return `Windows 不让用这个名字：${seg}`;
  }
  return null;
}

/** 「a.png」, 「Assets」, 「a.png 等 3 项」: how a send is called in lists and notifications. */
export function transferTitle(t: { roots: string[] }): string {
  const [first = "（空）", ...rest] = t.roots;
  return rest.length ? `${first} 等 ${t.roots.length} 项` : first;
}

/** The top-level names that are folders: some file or empty folder is inside them. */
export function transferFolders(t: { roots: string[]; files: TransferEntry[]; dirs: string[] }): string[] {
  const inside = new Set([...t.files.map((f) => f.path), ...t.dirs].filter((p) => p.includes("/")).map((p) => p.slice(0, p.indexOf("/"))));
  for (const d of t.dirs) if (!d.includes("/")) inside.add(d);
  return t.roots.filter((r) => inside.has(r));
}

export const transferBytesText = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
