// What the desktop client's shell (packages/relay-app, fixed, Electron) gives the client's content (packages/relay-ui,
// hot-updated from the service) as `window.relayShell`. In a browser there is no shell: the content runs without
// saved passwords, notifications, AI hookup and updates. Bump SHELL_VERSION when this changes; content built for a
// newer shell says so in its manifest (minShell).

export const SHELL_VERSION = 1;

import type { TransferEntry } from "./transfer-protocol.js";

export interface SavedAccount {
  server: string;
  name: string;
  /** null when it was saved without the password. */
  password: string | null;
  lastUsed: number;
}

export interface UpdateInfo {
  current: string | null;
  latest: string;
  /** The content needs a newer shell: download the client again from the service's page (or, with updatedBy, update it
   * in AMO 平台). */
  needShell: boolean;
  /** "platform": this desktop program was installed by AMO 平台 and only the platform updates it (2026-10-28). */
  updatedBy?: "platform";
}

export interface ShellInfo {
  shellVersion: number;
  /** This desktop program's build (relay-release --shell); undefined for builds from before it was stamped. */
  shellBuild?: string;
  /** "platform": installed by AMO 平台 (its own version folder, Electron's files shared with the other tools): no
   * 更新桌面程序 here — updateShell refuses — and a newer desktop program is had from the platform. Absent: the zip
   * people unpacked themselves, which updates itself as before. Added 2026-10-28. */
  updatedBy?: "platform";
  contentVersion: string;
  server: string;
  update: UpdateInfo | null;
  platform: string;
}

/** How an AI client starts this machine's relay MCP (the shell's own exe runs it as Node). */
export interface McpHookup {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The command line for agents without MCP, e.g. "C:\…\amo-relay.cmd". */
  cli: string;
}

/** 传文件: what was picked to send (files, folders, dropped ones), listed as a send lists it. */
export interface PickedSend {
  /** Names the pick on this computer until it is sent (bind). */
  pick: string;
  roots: Array<{ name: string; folder: boolean }>;
  entries: TransferEntry[];
  /** Empty folders. */
  dirs: string[];
  totalSize: number;
  /** Left out, with why (a link, unreadable, the same name as one already picked). */
  skipped: string[];
}

/** 传文件: a send accepted on this computer — the folder it goes into, the names its top-level items got there. */
export interface ReceiveState {
  dir: string;
  names: Record<string, string>;
  /** Paths of the send already saved here. */
  done: string[];
}

/**
 * 传文件 (2026-11-23, plans/relay-file-transfer.md 第 2 项): what the shell does on this computer's disk for a send. The
 * content (relay-ui transfer.ts) talks to the service and drives it; the shell reads only files the person picked and
 * writes only into the folder a send was accepted into. Optional: added after shell 1 shipped (a shell without it says
 * 传文件 needs a newer desktop program).
 */
export interface ShellTransfer {
  /** This computer (%APPDATA%\AMO\device.json, made when there is none). */
  device(): Promise<{ id: string; name: string }>;
  /** The system's picker; null when cancelled. `addTo`: add to a pick made before. */
  pickFiles(addTo?: string | null): Promise<PickedSend | null>;
  pickFolder(addTo?: string | null): Promise<PickedSend | null>;
  /** Files or folders dropped on the page. */
  dropped(files: File[], addTo?: string | null): Promise<PickedSend | null>;
  /** The pick was sent as `transferId` (only the `keep` top-level names). */
  bind(pick: string, transferId: string, keep?: string[]): Promise<void>;
  read(transferId: string, path: string, offset: number, length: number): Promise<Uint8Array>;
  hash(transferId: string, path: string): Promise<{ sha256: string; size: number }>;
  forgetSend(transferId: string): Promise<void>;
  /** Where sends are saved unless changed when accepting (下载\AMO 中转 at first). */
  receiveDir(): Promise<string>;
  setReceiveDir(dir: string): Promise<string>;
  /** The system's folder picker; null when cancelled. */
  chooseDir(current?: string): Promise<string | null>;
  prepare(transferId: string, dir: string, plan: { roots: string[]; folders: string[]; dirs: string[] }): Promise<ReceiveState>;
  received(transferId: string): Promise<ReceiveState | null>;
  /** -1: saved already. */
  partSize(transferId: string, path: string): Promise<number>;
  write(transferId: string, path: string, offset: number, data: Uint8Array): Promise<void>;
  /** The saved path; false when it did not match its sha256 (the part is gone, download it again). */
  finish(transferId: string, path: string, sha256: string): Promise<string | false>;
  /** The send ended before everything came: the parts go. */
  discard(transferId: string): Promise<void>;
  openFolder(transferId: string): Promise<void>;
  /** Drops this computer's records of sends not in `keep`. */
  prune(keep: string[]): Promise<void>;
}

export interface RelayShell {
  info(): Promise<ShellInfo>;
  /**
   * The team login AMO 平台 keeps (2026-10-29, AGENTS.md rule 7: login lives in the platform), read when asked; null when
   * nobody is logged in there. Absent in shells from before it: the content falls back to its own login.
   */
  platformAccount?(): Promise<{ server: string; name: string; key: string } | null>;
  accounts(): Promise<SavedAccount[]>;
  saveAccount(account: { server: string; name: string; password: string | null }): Promise<void>;
  forgetAccount(server: string, name: string): Promise<void>;
  /** The identity this machine's MCP and command line use; null on logout. */
  signedIn(identity: { server: string; name: string; key: string } | null): Promise<void>;
  mcp(): Promise<McpHookup>;
  copy(text: string): Promise<void>;
  notify(n: { title: string; body: string; threadId: string }): void;
  /** A notification was clicked. */
  onOpenThread(listener: (threadId: string) => void): void;
  setUnread(count: number): void;
  checkUpdate(): Promise<UpdateInfo | null>;
  /** Downloads the latest content, switches to it and reloads the window (no restart). */
  applyUpdate(): Promise<void>;
  onUpdateProgress(listener: (p: { done: number; total: number }) => void): void;
  /** The window is on screen and focused: someone is using it (an update waits). Optional: added after shell 1 shipped. */
  inUse?(): Promise<boolean>;
  /** Writes the usage text for agents to a file of this machine and says where (复制用法 then copies just that path).
   * Optional: added after shell 1 shipped; without it the whole text is copied. */
  writeUsage?(text: string): Promise<string>;
  /** The window has no system title bar: the page draws minimise / maximise / close (not on a Mac, which keeps its
   * traffic lights). Optional: added after shell 1 shipped; without it the window has the system's title bar. */
  /** 更新桌面程序: downloads the service's desktop program, checks it, puts it in place of this one and restarts into
   * it (Windows). Optional: added after shell 1 shipped. */
  updateShell?(): Promise<void>;
  onShellProgress?(listener: (p: { step: "download" | "check" | "unpack" | "replace" | "restart"; done: number; total: number }) => void): void;
  windowControls?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximized(listener: (maximized: boolean) => void): void;
  };
  /** Back to the loader, to enter another service address. */
  changeServer(): void;
  openExternal(url: string): void;
  /**
   * 在中转里打开 from AMO Studio (2026-11-05, plans/done/relay-round-2026-11-05.md J2): the thread the shell was started (or
   * woken) with `--open-thread`, once — later calls give null. Optional: added after shell 1 shipped.
   */
  takeOpenThread?(): Promise<string | null>;
  /**
   * What the shell was started (or woken) with to open (2026-11-23, relay-app open-arg.ts): `cowork:<id>` or
   * `thread:<id>` (`--open=…`, or the older `--open-thread`), once — later calls give null. With onOpen, a shell that
   * has these sends a notification's click there too (`thread:<id>`), so the content listens on onOpen alone.
   * Optional: added after shell 1 shipped; an older one has only takeOpenThread / onOpenThread.
   */
  takeOpen?(): Promise<string | null>;
  onOpen?(listener: (ref: string) => void): void;
  /**
   * 在 Studio 里打开 (J1): a session's mark (Via.conv) names a Studio session on this computer that is running now —
   * its device is this one's (device.json) and a Studio Host is up. Optional: added after shell 1 shipped.
   */
  studioHas?(conv: string): Promise<boolean>;
  /** Shows that Studio session in the workbench; what went wrong, in words, or null. */
  openInStudio?(conv: string): Promise<string | null>;
  /** 传文件 (2026-11-23). Optional: added after shell 1 shipped. */
  transfer?: ShellTransfer;
}
