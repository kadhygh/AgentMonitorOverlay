// What the platform's window shows, as the main process hands it over (platform:view). Types only: the page
// (packages/ui/src/platform) imports them too, so nothing here may need Node.

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

export interface PlatformView {
  /** The platform's own version. */
  version: string;
  testMode: boolean;
  account: { server: string; name: string } | null;
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
  dirs: { apps: string; studioData: string | null; settings: string };
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
  refresh(): Promise<void>;
  install(tool: string): Promise<void>;
  rollback(tool: string): Promise<void>;
  uninstall(tool: string): Promise<void>;
  open(tool: string): Promise<OpenResult>;
  setChannel(channel: Channel): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  pickStudioDataDir(): Promise<void>;
  openPath(which: "apps" | "studioData" | "settings"): Promise<void>;
  dismiss(tool: string): Promise<void>;
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

export type ServerCheck = { ok: true; name: string | null; invite: boolean } | { ok: false; message: string };

export type OpenResult ={ ok: true } | { ok: false; reason: "need-studio-dir" | "not-installed" | "failed"; message: string };
