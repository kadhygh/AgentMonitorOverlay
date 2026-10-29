// What the platform's window shows, as the main process hands it over (platform:view). Types only: the page
// (packages/ui/src/platform) imports them too, so nothing here may need Node.
import type { EnvironmentView } from "./environment-view.js";

export type Channel = "stable" | "test";

export interface TaskView {
  kind: "install" | "update" | "rollback" | "uninstall";
  version: string | null;
  /** manifest → linking → downloading → switching. */
  phase: "manifest" | "linking" | "downloading" | "switching" | "removing";
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  /** Files brought over from the version before (hard links), not downloaded. */
  reused: number;
}

export interface StudioHealthView {
  /** Studio's Host answers on its data dir's host.json. */
  hostUp: boolean;
  /** Sessions running, when the Host says (/api/health → running); null when it does not. */
  sessions: number | null;
  /** The Studio version that started the Host (/api/health → version, 2026-10-29): "dev" from the sources; null when an older Host does not say. */
  version: string | null;
  /**
   * 重启 Studio (system.ts's studioRestart): "ready" — the Host is older than the installed Studio and nothing is at work;
   * "busy" — older, but sessions are at work (not until they stop); "unsupported" — a Host too old to say its version or
   * be asked to stop; "none".
   */
  restart: "none" | "ready" | "busy" | "unsupported";
  /** 重启 Studio is under way: stopping the old one, then opening the installed one. */
  restarting: boolean;
}

export interface ToolView {
  id: string;
  name: string;
  desc: string;
  /** The version the chosen channel has, or null when the channel does not have this tool. */
  available: string | null;
  /** That version's notes (Markdown), as published. */
  notes: string | null;
  /** The version `current` points at, or null when not installed. */
  installed: string | null;
  /** How the installed version stands against the channel's. */
  standing: "not-installed" | "latest" | "update" | "ahead" | "not-in-channel";
  /** The version 回滚 goes back to (the other one kept), if any. */
  rollbackTo: string | null;
  /** A process runs from this tool's folder. */
  running: boolean;
  /** A short line under the status (e.g. Studio already brings the Reviewer). */
  hint: string | null;
  task: TaskView | null;
  /** How the last action on it ended, until the next one. */
  result: { tone: "ok" | "warn" | "error"; text: string } | null;
  /** Studio only: whether its Host runs and how many sessions it has going (read only). */
  studio: StudioHealthView | null;
}

/** How the running platform stands against its own updates (self-update.ts's selfStanding). */
export type SelfStanding = "dev" | "latest" | "update" | "restart" | "newer-here";

/** The platform's own updates (设置 → 平台更新, and the hint in the title bar). */
export interface SelfView {
  /** dev: from the sources; installed: from <root>\apps\platform; outer: the entry, <root>\AMO Platform.exe (self-update.ts). */
  place: "dev" | "installed" | "outer";
  /** The folder the running platform's program is in (null in development). */
  dir: string | null;
  /** The entry the person double-clicks (<root>\AMO Platform.exe); null in development. */
  entry: string | null;
  /** Run from apps\platform: whether the entry was brought to this version (entry.ts) — "absent" when there is no entry. */
  entryState: "current" | "failed" | "absent" | null;
  standing: SelfStanding;
  /** The version the chosen channel has, or null. */
  available: string | null;
  notes: string | null;
  /** The version <root>\apps\platform\current points at, or null. */
  installed: string | null;
  /** Where the platform's updates go (<root>\apps\platform). */
  home: string;
  task: TaskView | null;
  result: { tone: "ok" | "warn" | "error"; text: string } | null;
}

/** The platform's folder (self-update.ts's root) and whether it can hold the tools (root-check.ts). */
export interface RootView {
  path: string;
  /** False: nothing can be installed or updated; 工具 says to move the folder. */
  writable: boolean;
  /** Network and removable drives work, with a warning; "unknown" until Windows has said (or when it does not). */
  drive: "local" | "network" | "removable" | "unknown";
}

/** 账号 (2026-10-28: moved here from the relay client): what the team server says of the account (GET /api/me). */
export interface ProfileView {
  /** The team server's name (e.g. 「策划组」), "" when it has none. */
  service: string;
  /** 负责什么. */
  role: string;
  /** "" for none: the account name is shown. */
  nick: string;
  /** A data: URL, or null for the initial on a colour. */
  avatar: string | null;
}

export interface PlatformView {
  /** The platform's own version. */
  version: string;
  self: SelfView;
  testMode: boolean;
  account: { server: string; name: string } | null;
  /** The account's profile: read with the channels (refresh); `profile` stays what was last read when a read fails. */
  profile: { state: "idle" | "loading" | "ready" | "error"; data: ProfileView | null; message: string | null };
  /** The login page: why it is shown again (a key that stopped working), or why the last try failed. */
  loginError: string | null;
  loggingIn: boolean;
  /** Recent servers, newest first (at most 3). */
  servers: string[];
  /** For the login form: the name last used. */
  lastName: string | null;
  channel: Channel;
  /** Started with --channel: the setting cannot change it for this run. */
  channelFromArgs: boolean;
  connection: { state: "idle" | "checking" | "online" | "offline"; message: string | null };
  tools: ToolView[];
  root: RootView;
  dirs: { root: string; apps: string; studioData: string | null; settings: string };
  openAtLogin: boolean;
}

/** What the page can ask the main process to do (platform:call). */
export interface PlatformCalls {
  login(server: string, name: string, password: string): Promise<void>;
  /** Makes an account on the team server and logs in with it; the error comes back to the form (not loginError). */
  register(input: RegisterForm): Promise<RegisterResult>;
  /** For the register form: whether the server is there and wants the invite passphrase. */
  serverInfo(server: string): Promise<ServerCheck>;
  logout(): Promise<void>;
  /** 账号: the profile read again from the team server. */
  loadProfile(): Promise<void>;
  /** 账号's 保存: the nickname, picture and 负责什么 on the team server (PATCH /api/me); errors come back to the page. */
  saveProfile(patch: ProfilePatch): Promise<ProfileSaveResult>;
  refresh(): Promise<void>;
  install(tool: string): Promise<void>;
  rollback(tool: string): Promise<void>;
  uninstall(tool: string): Promise<void>;
  open(tool: string): Promise<OpenResult>;
  /** 关闭 (2026-10-29): the running tool quits its own way (Studio asks first when sessions are at work, as its 完全退出 does). */
  close(tool: string): Promise<OpenResult>;
  /**
   * 重启 Studio (2026-10-29): the running Studio and its Host stop (refused by the Host while sessions are at work), then
   * the installed Studio opens. Only when clicked (AGENTS.md, constraint 6).
   */
  restartStudio(): Promise<void>;
  /** Studio's card: its Host asked again (opening 工具, every 10 s while the window is shown). */
  refreshStudio(): Promise<void>;
  setChannel(channel: Channel): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  pickStudioDataDir(): Promise<void>;
  openPath(which: "root" | "apps" | "studioData" | "settings"): Promise<void>;
  dismiss(tool: string): Promise<void>;
  /** 环境 (environment-view.ts): the last check, or a new one. */
  environment(fresh?: boolean): Promise<EnvironmentView>;
  openDownload(id: string): Promise<void>;
  copyInstallCommand(): Promise<void>;
  /** 更新平台: the channel's platform into <root>\apps\platform, made current; the running one stays until 重启平台. */
  updateSelf(): Promise<void>;
  /** 重启平台 / 打开那个: <root>\apps\platform\current's platform starts and this one quits. */
  restartSelf(): Promise<void>;
  /** 知道了 on the platform's update result. */
  dismissSelf(what: "result"): Promise<void>;
}

export interface RegisterForm {
  server: string;
  name: string;
  password: string;
  /** 负责什么, may be empty. */
  role: string;
  /** Only when the server wants one. */
  passphrase?: string;
}

/** `code` as @amo-studio/account's AccountError: conflict = the name is taken, unauthorized = the passphrase is wrong. */
export type RegisterResult = { ok: true } | { ok: false; code: string; message: string };

/** Only what is given changes (@amo-studio/account's ProfilePatch); avatar null for the initial. */
export interface ProfilePatch {
  nick?: string;
  role?: string;
  avatar?: string | null;
}

export type ProfileSaveResult = { ok: true } | { ok: false; message: string };

export type ServerCheck = { ok: true; name: string | null; invite: boolean } | { ok: false; message: string };

export type OpenResult ={ ok: true } | { ok: false; reason: "need-studio-dir" | "not-installed" | "failed"; message: string };
