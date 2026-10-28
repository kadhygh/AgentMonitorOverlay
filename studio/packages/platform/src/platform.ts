import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { amoHome, AccountError, clearAccount, fetchProfile, login, logout, platformFile, programsFile, readAccount, readJsonFile, register, serverInfo, updateProfile, type Account, type Env, type Protector } from "@amo-studio/account";
import { PlatformClient } from "./client.js";
import { entryOldFiles, entryVersion, refreshEntry, type EntryRefresh } from "./entry.js";
import { Installer, type InstallProgress, type ProgramsFile } from "./installer.js";
import { channelVersion, compareVersions, PlatformError, type Channels, type Manifest } from "./manifest.js";
import { planLaunch, startDetached, startEnv, type LaunchSpec } from "./launch.js";
import { rootDrive, rootWritable, type RootDrive } from "./root-check.js";
import { currentExe, entryExe, loginItemExe, restartArgs, SELF, selfPlace, selfStanding, type SelfPlace } from "./self-update.js";
import { channelFromArgs, readSettings, updateSettings } from "./settings.js";
import { foldersInUse, runningExePaths, studioHealth } from "./system.js";
import { CLAUDE_INSTALL_COMMAND, downloadUrl, EnvironmentChecker, studioSdkClaudeCodeVersion } from "./environment.js";
import type { EnvironmentView } from "./environment-view.js";
import type { Channel, OpenResult, PlatformCalls, PlatformView, ProfilePatch, ProfileSaveResult, RegisterForm, RegisterResult, RootView, SelfView, ServerCheck, StudioHealthView, TaskView, ToolView } from "./view.js";

// AMO 平台's state and actions, without Electron (main.ts wires it to the window, the tray and the dialogs; the tests
// drive it directly). One account (the team server's), the channel's tools, and what is installed here.

/** The tools the platform knows by id; others a server lists are shown under their manifest's name. */
const KNOWN: Record<string, { name: string; desc: string }> = {
  studio: { name: "AMO Studio", desc: "工作台：看板、任务、和模型的会话。自带 AMO 便签和 Reviewer。" },
  reviewer: { name: "AMO Reviewer（独立版）", desc: "Git Review 和查看器，可以单独用。" },
  notes: { name: "AMO 便签（独立版）", desc: "随手记，托盘常驻，可以单独用。" },
  // Since 2026-10-28 (the user): its desktop program comes from here too; what it shows still updates from the service.
  relay: { name: "AMO 中转", desc: "策划的 AI 把要确认的事发给程序，人和人聊天。界面由服务器更新，桌面程序在这里更新。" },
};
/** Studio first; AMO 中转 next, a tool of its own, before the two that Studio already carries. */
const ORDER = ["studio", "relay", "reviewer", "notes"];
/** Listed by the server but not a tool to install from here: the platform updates itself (设置 → 平台更新, self-update.ts). */
const HIDDEN = new Set([SELF]);

export interface PlatformShell {
  pickFolder(title: string, start: string | null): Promise<string | null>;
  openPath(path: string): Promise<void>;
  /** `exe`: the program to register (self-update.ts's loginItemExe); null in development (electron with this package). */
  setOpenAtLogin(on: boolean, exe: string | null): void;
  /** The 环境 page's 去下载 (the system browser) and 复制; absent where nothing should open (unit tests). */
  openExternal?(url: string): Promise<void>;
  copyText?(text: string): void;
}

export interface PlatformOptions {
  env: Env;
  argv: readonly string[];
  version: string;
  testMode: boolean;
  shell: PlatformShell;
  protector?: Protector;
  fetch?: typeof fetch;
  /** Exe paths of running processes (tests hand in their own). */
  runningPaths?: () => Promise<string[]>;
  launch?: (spec: LaunchSpec) => Promise<void>;
  /** The running platform's program; null or absent when it runs from the sources (development: no self-updates). */
  selfExe?: string | null;
  /** 重启平台: starts `spec` and ends this process (main.ts; tests record it). */
  restart?: (spec: LaunchSpec) => Promise<void>;
  pid?: number;
  /** Whether the platform's folder takes files, and the drive it is on (root-check.ts; tests hand in their own). */
  rootWritable?: (root: string) => boolean;
  rootDrive?: (root: string) => Promise<RootDrive>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Platform implements PlatformCalls {
  readonly installer: Installer;
  private account: Account | null = null;
  private client: PlatformClient | null = null;
  private channels: Channels | null = null;
  private readonly manifests = new Map<string, Manifest>();
  private connection: PlatformView["connection"] = { state: "idle", message: null };
  private running: Record<string, boolean> = {};
  private studio: StudioHealthView = { hostUp: false, sessions: null };
  private readonly tasks = new Map<string, TaskView>();
  private readonly results = new Map<string, ToolView["result"]>();
  private loginError: string | null = null;
  private loggingIn = false;
  private profile: PlatformView["profile"] = { state: "idle", data: null, message: null };
  private readonly listeners = new Set<(v: PlatformView) => void>();
  private readonly argChannel: Channel | null;
  readonly place: SelfPlace;
  private selfTask: TaskView | null = null;
  private selfResult: SelfView["result"] = null;
  /** This run installed the platform version `current` points at (so 重启平台, not 打开那个). */
  private selfInstalledThisRun = false;
  /** The platform's folder: writable until init has looked (so nothing is greyed out for a moment), the drive unknown. */
  private readonly rootView: RootView;
  /** Run from apps\platform: how bringing the entry to this version went (entry.ts), for 设置 and the tests. */
  lastEntryRefresh: EntryRefresh | null = null;
  private entryState: SelfView["entryState"] = null;

  constructor(private readonly options: PlatformOptions) {
    this.argChannel = channelFromArgs(options.argv);
    // Everything in the platform's own folder (self-update.ts's root, 2026-10-28), not in AppData.
    this.place = selfPlace(options.selfExe ?? null, options.env);
    this.rootView = { path: this.place.root, writable: true, drive: "unknown" };
    this.installer = new Installer({
      appsDir: join(this.place.root, "apps"),
      programsFile: programsFile(options.env),
      isRunning: async (tool) => (await this.checkRunning([tool]))[tool] === true,
    });
  }

  // ---- state

  onChange(cb: (v: PlatformView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    const v = this.view();
    for (const cb of this.listeners) cb(v);
  }

  channel(): Channel {
    return this.argChannel ?? readSettings(this.options.env).channel;
  }

  private programs(): ProgramsFile["tools"] {
    return readJsonFile<ProgramsFile>(programsFile(this.options.env))?.tools ?? {};
  }

  private toolName(id: string): string {
    return KNOWN[id]?.name ?? [...this.manifests.values()].find((m) => m.tool === id)?.name ?? id;
  }

  /** The installed tools, for the tray's 打开 items. */
  installedTools(): Array<{ id: string; name: string }> {
    const programs = this.programs();
    return this.toolIds()
      .filter((id) => programs[id])
      .map((id) => ({ id, name: this.toolName(id).replace(/（独立版）$/, "") }));
  }

  private toolIds(): string[] {
    const ids = new Set<string>([...Object.keys(this.channels?.stable ?? {}), ...Object.keys(this.channels?.test ?? {}), ...this.installer.tools()].filter((t) => !HIDDEN.has(t)));
    return [...ids].sort((a, b) => {
      const x = ORDER.indexOf(a);
      const y = ORDER.indexOf(b);
      return x !== y ? (x < 0 ? 99 : x) - (y < 0 ? 99 : y) : a.localeCompare(b);
    });
  }

  view(): PlatformView {
    const settings = readSettings(this.options.env);
    const channel = this.channel();
    const studioInstalled = this.installer.currentVersion("studio") !== null;
    const tools: ToolView[] = this.toolIds().map((id) => {
      const available = this.channels ? channelVersion(this.channels, channel, id) : null;
      const manifest = available ? this.manifests.get(`${id}@${available}`) : undefined;
      const installed = this.installer.currentVersion(id);
      const hint = id === "reviewer" && studioInstalled ? "Studio 里已经带了 Reviewer，单独用才需要装这一份。" : id === "notes" && studioInstalled ? "Studio 会顺带启动便签，单独用才需要装这一份。" : null;
      return {
        id,
        name: this.toolName(id),
        desc: KNOWN[id]?.desc ?? "",
        available,
        notes: manifest?.notes ?? null,
        installed,
        standing: !installed ? "not-installed" : !available ? "not-in-channel" : compareVersions(available, installed) > 0 ? "update" : compareVersions(available, installed) < 0 ? "ahead" : "latest",
        rollbackTo: installed ? (this.installer.rollbackTarget(id)?.version ?? null) : null,
        running: this.running[id] === true,
        hint,
        task: this.tasks.get(id) ?? null,
        result: this.results.get(id) ?? null,
        studio: id === "studio" ? this.studio : null,
      };
    });
    return {
      version: this.options.version,
      self: this.selfView(channel),
      testMode: this.options.testMode,
      account: this.account ? { server: this.account.server, name: this.account.name } : null,
      profile: this.profile,
      loginError: this.loginError,
      loggingIn: this.loggingIn,
      servers: settings.recentServers,
      lastName: settings.lastName,
      channel,
      channelFromArgs: this.argChannel !== null,
      connection: this.connection,
      tools,
      root: { ...this.rootView },
      dirs: { root: this.place.root, apps: this.installer.appsDir, studioData: settings.studioDataDir, settings: amoHome(this.options.env) },
      openAtLogin: settings.openAtLogin,
    };
  }

  // ---- start, account

  /**
   * Looks at the platform's folder (can it take files, which drive), cleans up after any install that stopped half way,
   * brings the entry to this version when run from apps\platform, reads the saved login, and asks the server.
   */
  async init(): Promise<void> {
    const root = this.place.root;
    this.rootView.writable = (this.options.rootWritable ?? rootWritable)(root);
    const drive = (this.options.rootDrive ?? rootDrive)(root)
      .then((d) => {
        this.rootView.drive = d;
        this.changed();
      })
      .catch(() => undefined);
    if (this.rootView.writable) {
      for (const tool of this.installer.tools()) {
        try {
          this.installer.repair(tool);
        } catch {
          // a folder in use: left for the next time
        }
      }
      await this.refreshEntry();
    }
    // Only a record of where the platform's folder is, for other programs (programs.json has each tool's own path).
    if (readSettings(this.options.env).root !== root) {
      try {
        updateSettings({ root }, this.options.env);
      } catch {
        // %APPDATA%\AMO not writable: the platform works without the record
      }
    }
    this.account = await readAccount({ env: this.options.env, ...(this.options.protector ? { protector: this.options.protector } : {}) });
    this.client = this.account ? new PlatformClient(this.account.server, this.account.key, this.options.fetch) : null;
    if (this.account) {
      // Registered again on every start: it follows the folder (the entry, <root>\AMO Platform.exe), moved or not.
      const s = readSettings(this.options.env);
      if (s.openAtLogin) this.options.shell.setOpenAtLogin(true, this.loginExe());
    }
    this.changed();
    await this.refresh();
    await drive;
  }

  /**
   * Run from <root>\apps\platform\<version>: the entry's files (<root>\AMO Platform.exe and the rest the zip unpacked)
   * brought to this version (entry.ts), so the next double-click opens it without forwarding. Not when there is no
   * entry, nor when the entry is newer (unpacked again from a newer zip). A failure is tried again at the next start.
   */
  private async refreshEntry(): Promise<void> {
    if (this.place.kind !== "installed") return;
    const entry = entryExe(this.place)!;
    if (!existsSync(entry)) {
      this.entryState = "absent";
      return;
    }
    let versionDir: string;
    try {
      versionDir = realpathSync(this.place.dir);
    } catch {
      return;
    }
    const version = basename(versionDir);
    const versions = this.installer.versions(SELF);
    const record = versions.find((v) => v.version === version);
    if (!record) return;
    const told = entryVersion(this.place.root);
    if (told && compareVersions(told, version) > 0) return;
    const filesOf = (v: string) => versions.find((x) => x.version === v)?.manifest.files.map((f) => f.path) ?? null;
    this.lastEntryRefresh = await refreshEntry({ root: this.place.root, version, versionDir, files: record.manifest.files, oldFiles: entryOldFiles(this.place.root, filesOf) });
    this.entryState = this.lastEntryRefresh.error ? "failed" : "current";
  }

  /** Why nothing can be installed here, or null: the platform's folder takes no files. */
  private readonlyText(): string | null {
    return this.rootView.writable ? null : `这个文件夹不能写入（${this.place.root}），装不了也更新不了。把整个文件夹移到能写的位置（比如 D:\\TOOLS）再打开。`;
  }

  private accountOptions() {
    return { env: this.options.env, ...(this.options.protector ? { protector: this.options.protector } : {}), ...(this.options.fetch ? { fetch: this.options.fetch } : {}) };
  }

  /** Logged in (by a login or a registration): the account's client, and the channels asked again for it. */
  private signedIn(account: Account): void {
    this.account = account;
    this.loginError = null;
    updateSettings({ lastName: account.name }, this.options.env);
    this.client = new PlatformClient(account.server, account.key, this.options.fetch);
    this.channels = null;
    this.manifests.clear();
  }

  async login(server: string, name: string, password: string): Promise<void> {
    if (this.loggingIn) return;
    this.loggingIn = true;
    this.loginError = null;
    this.changed();
    try {
      this.signedIn(await login({ server, name, password }, this.accountOptions()));
    } catch (err) {
      this.loginError = err instanceof AccountError ? err.message : `登录没成功：${message(err)}`;
    } finally {
      this.loggingIn = false;
      this.changed();
    }
    if (this.account) await this.refresh();
  }

  /**
   * The login page's 注册 (10-28: the platform is the only place to log in, so people without an account register here):
   * an account on the team server, then logged in with it as after a login. Errors go back to the form.
   */
  async register(form: RegisterForm): Promise<RegisterResult> {
    if (this.loggingIn) return { ok: false, code: "busy", message: "正在登录，稍等一下。" };
    this.loggingIn = true;
    this.changed();
    let result: RegisterResult;
    try {
      this.signedIn(await register({ server: form.server, name: form.name, password: form.password, role: form.role, ...(form.passphrase ? { passphrase: form.passphrase } : {}) }, this.accountOptions()));
      result = { ok: true };
    } catch (err) {
      result = err instanceof AccountError ? { ok: false, code: err.code, message: err.message } : { ok: false, code: "error", message: `注册没成功：${message(err)}` };
    } finally {
      this.loggingIn = false;
      this.changed();
    }
    if (result.ok) await this.refresh();
    return result;
  }

  async serverInfo(server: string): Promise<ServerCheck> {
    try {
      return { ok: true, ...(await serverInfo(server, this.accountOptions())) };
    } catch (err) {
      return { ok: false, message: message(err) };
    }
  }

  async logout(): Promise<void> {
    await logout(this.accountOptions());
    this.forget(null);
  }

  /** Back to the login page; `why` says what happened (a key the server no longer takes). */
  private forget(why: string | null): void {
    this.account = null;
    this.client = null;
    this.channels = null;
    this.manifests.clear();
    this.connection = { state: "idle", message: null };
    this.profile = { state: "idle", data: null, message: null };
    this.loginError = why;
    this.changed();
  }

  // ---- 账号 (2026-10-28, the user: the nickname, picture and 负责什么 are edited here, no longer in the relay client)

  /** The profile read from the team server into the view; a key it no longer takes logs out, as elsewhere. */
  private async readProfile(account: Account): Promise<void> {
    this.profile = { ...this.profile, state: "loading", message: null };
    try {
      const p = await fetchProfile(account, this.accountOptions());
      if (this.account !== account) return;
      this.profile = { state: "ready", data: { service: p.service, role: p.role, nick: p.nick, avatar: p.avatar }, message: null };
    } catch (err) {
      if (this.account !== account) return;
      const text = this.failed(err);
      // Logged out by it: the login page says why.
      if (this.account !== account) return;
      this.profile = { state: "error", data: this.profile.data, message: text };
    }
  }

  async loadProfile(): Promise<void> {
    if (!this.account) return;
    const read = this.readProfile(this.account);
    this.changed();
    await read;
    this.changed();
  }

  async saveProfile(patch: ProfilePatch): Promise<ProfileSaveResult> {
    const account = this.account;
    if (!account) return { ok: false, message: "还没登录" };
    try {
      await updateProfile(account, patch, this.accountOptions());
    } catch (err) {
      const text = this.failed(err);
      return { ok: false, message: err instanceof AccountError ? text : `没保存上：${text}` };
    }
    // What the server keeps (trimmed), read back.
    await this.loadProfile();
    return { ok: true };
  }

  private failed(err: unknown): string {
    if ((err instanceof PlatformError || err instanceof AccountError) && err.code === "unauthorized") {
      clearAccount({ env: this.options.env });
      this.forget("登录已失效，请重新登录。");
    }
    return message(err);
  }

  // ---- server and machine

  private async checkRunning(ids: string[]): Promise<Record<string, boolean>> {
    const paths = await (this.options.runningPaths ?? runningExePaths)();
    const inUse = foldersInUse(paths, ids.map((id) => this.installer.toolDir(id)));
    return Object.fromEntries(ids.map((id, i) => [id, inUse[i] === true]));
  }

  /** Asks the server for the channels and their manifests, and the machine which tools run. */
  async refresh(): Promise<void> {
    const local = async () => {
      const ids = this.toolIds();
      const [running, studio] = await Promise.all([this.checkRunning(ids), studioHealth(readSettings(this.options.env).studioDataDir, this.options.fetch)]);
      this.running = running;
      this.studio = studio;
    };
    const client = this.client;
    if (!client) {
      await local();
      this.changed();
      return;
    }
    this.connection = { state: "checking", message: null };
    // The profile (账号, and the face at the foot of the pages) alongside; its failure does not stop the tools.
    const profile = this.account ? this.readProfile(this.account) : null;
    this.changed();
    try {
      const channels = await client.channels();
      const channel = this.channel();
      for (const id of new Set([...Object.keys(channels.stable), ...Object.keys(channels.test)])) {
        const v = channelVersion(channels, channel, id);
        // The platform's own manifest too: its notes are shown under 平台更新.
        if (!v || this.manifests.has(`${id}@${v}`)) continue;
        try {
          this.manifests.set(`${id}@${v}`, await client.manifest(id, v));
        } catch (err) {
          if (err instanceof PlatformError && err.code === "unauthorized") throw err;
          // One broken manifest does not hide the other tools; installing that one says what is wrong.
        }
      }
      if (this.client !== client) return;
      this.channels = channels;
      this.connection = { state: "online", message: null };
    } catch (err) {
      if (this.client !== client) return;
      const text = this.failed(err);
      if (this.account) this.connection = { state: "offline", message: text };
    }
    await profile;
    await local();
    this.changed();
  }

  // ---- tools

  private async run(tool: string, task: TaskView, work: () => Promise<ToolView["result"]>): Promise<void> {
    if (this.tasks.has(tool)) return;
    this.tasks.set(tool, task);
    this.results.delete(tool);
    this.changed();
    try {
      this.results.set(tool, await work());
    } catch (err) {
      this.results.set(tool, { tone: "error", text: this.failed(err) });
    } finally {
      this.tasks.delete(tool);
      this.changed();
    }
    // Asking Windows what runs takes a moment (PowerShell): the result is shown first, the running marks follow.
    this.running = await this.checkRunning(this.toolIds()).catch(() => this.running);
    this.changed();
  }

  /** Installs the channel's version, or updates to it (also back to it, when what is installed is newer). */
  async install(tool: string): Promise<void> {
    const client = this.client;
    const readonly = this.readonlyText();
    if (readonly) {
      this.results.set(tool, { tone: "error", text: readonly });
      return this.changed();
    }
    if (!client || !this.channels) {
      this.results.set(tool, { tone: "error", text: "现在连不上服务器，装不了。" });
      return this.changed();
    }
    const version = channelVersion(this.channels, this.channel(), tool);
    if (!version) {
      this.results.set(tool, { tone: "error", text: "这个通道里没有它。" });
      return this.changed();
    }
    const installed = this.installer.currentVersion(tool);
    const kind = installed ? "update" : "install";
    const task: TaskView = { kind, version, phase: "manifest", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, reused: 0 };
    await this.run(tool, task, async () => {
      // Asked alongside the download, not before it: it only decides how the result is worded.
      const runningCheck = this.checkRunning([tool]).catch(() => ({}) as Record<string, boolean>);
      const r = await this.installer.install(tool, version, client, (p: InstallProgress) => {
        Object.assign(task, p);
        this.changed();
      });
      const wasRunning = (await runningCheck)[tool] === true;
      const name = this.toolName(tool);
      const what = kind === "install" ? `已装好 ${version}` : installed && compareVersions(version, installed) < 0 ? `已换回 ${version}` : `已更新到 ${version}`;
      const later = wasRunning ? `，${name.replace(/（独立版）$/, "")} 正在运行，下次打开生效` : "";
      // Reused from any tool here (2026-10-29: the tools share their Electron files), not only this tool's last version.
      const reused = r.reused ? `（${r.reused} 个文件本机已经有了，没有重新下载）` : "";
      return { tone: "ok", text: `${what}${later}${reused}` };
    });
  }

  async rollback(tool: string): Promise<void> {
    const target = this.installer.rollbackTarget(tool)?.version ?? null;
    await this.run(tool, { kind: "rollback", version: target, phase: "switching", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, reused: 0 }, async () => {
      const runningCheck = this.checkRunning([tool]).catch(() => ({}) as Record<string, boolean>);
      const r = this.installer.rollback(tool);
      const wasRunning = (await runningCheck)[tool] === true;
      return { tone: "ok", text: `已回到 ${r.version}${wasRunning ? "，正在运行的那个下次打开生效" : ""}` };
    });
  }

  async uninstall(tool: string): Promise<void> {
    await this.run(tool, { kind: "uninstall", version: null, phase: "removing", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, reused: 0 }, async () => {
      await this.installer.uninstall(tool, this.toolName(tool).replace(/（独立版）$/, ""));
      return { tone: "ok", text: "已卸载" };
    });
  }

  async dismiss(tool: string): Promise<void> {
    this.results.delete(tool);
    this.changed();
  }

  async open(tool: string): Promise<OpenResult> {
    const plan = planLaunch(tool, this.programs()[tool], { studioDataDir: readSettings(this.options.env).studioDataDir, env: this.options.env, name: this.toolName(tool).replace(/（独立版）$/, ""), server: this.account?.server ?? null });
    if (!plan.ok) return plan;
    try {
      await (this.options.launch ?? startDetached)(plan.spec);
    } catch (err) {
      return { ok: false, reason: "failed", message: `没能打开：${message(err)}` };
    }
    // It takes a moment to show up among the processes.
    setTimeout(() => void this.checkRunning(this.toolIds()).then((r) => ((this.running = r), this.changed())).catch(() => undefined), 2000);
    return { ok: true };
  }

  // ---- settings

  async setChannel(channel: Channel): Promise<void> {
    updateSettings({ channel }, this.options.env);
    this.changed();
    await this.refresh();
  }

  async setOpenAtLogin(on: boolean): Promise<void> {
    this.options.shell.setOpenAtLogin(on, this.loginExe());
    updateSettings({ openAtLogin: on }, this.options.env);
    this.changed();
  }

  /** Studio's data dir: any folder outside the installed programs (an update replaces those folders). */
  async pickStudioDataDir(): Promise<void> {
    const current = readSettings(this.options.env).studioDataDir;
    const dir = await this.options.shell.pickFolder("选择 Studio 数据目录", current);
    if (!dir) return;
    const err = this.checkDataDir(dir);
    if (err) {
      this.results.set("studio", { tone: "error", text: err });
      return this.changed();
    }
    updateSettings({ studioDataDir: resolve(dir) }, this.options.env);
    this.results.delete("studio");
    this.studio = await studioHealth(resolve(dir), this.options.fetch);
    this.changed();
  }

  checkDataDir(dir: string): string | null {
    if (!isAbsolute(dir)) return "要选一个完整的文件夹路径。";
    const rel = relative(this.installer.appsDir, resolve(dir));
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return "Studio 数据目录不能放在工具的安装文件夹里：更新时那里会整个换掉。换一个文件夹。";
    return null;
  }

  async openPath(which: "root" | "apps" | "studioData" | "settings"): Promise<void> {
    const v = this.view();
    const path = which === "root" ? v.dirs.root : which === "apps" ? v.dirs.apps : which === "settings" ? v.dirs.settings : v.dirs.studioData;
    if (path) await this.options.shell.openPath(path);
  }

  // ---- the platform's own updates (self-update.ts)

  /** <root>\apps\platform\current\<exe> when a platform is installed there. */
  private installedSelfExe(): string | null {
    const current = this.installer.versions(SELF).find((v) => v.current);
    return current ? currentExe(this.installer.appsDir, current.manifest.exe) : null;
  }

  private loginExe(): string | null {
    return loginItemExe(this.place, this.installedSelfExe());
  }

  private selfView(channel: Channel): SelfView {
    const installed = this.installer.currentVersion(SELF);
    const available = this.channels ? channelVersion(this.channels, channel, SELF) : null;
    return {
      place: this.place.kind,
      dir: this.place.kind === "dev" ? null : this.place.dir,
      entry: entryExe(this.place),
      entryState: this.entryState,
      standing: selfStanding({ place: this.place.kind, running: this.options.version, installed, available, installedThisRun: this.selfInstalledThisRun }),
      available,
      notes: available ? (this.manifests.get(`${SELF}@${available}`)?.notes ?? null) : null,
      installed,
      home: this.installer.toolDir(SELF),
      task: this.selfTask,
      result: this.selfResult,
    };
  }

  /**
   * 更新平台: the channel's platform installed into <root>\apps\platform by the same engine as the tools (the shared
   * files are linked, not downloaded) and made current. The running platform is not touched; 重启平台 switches to it,
   * and that one brings the entry (<root>\AMO Platform.exe) to its version. Starting with Windows stays on the entry.
   */
  async updateSelf(): Promise<void> {
    if (this.selfTask) return;
    const done = (tone: "ok" | "warn" | "error", text: string) => {
      this.selfResult = { tone, text };
      this.changed();
    };
    if (this.place.kind === "dev") return done("warn", "这是从源码启动的开发版，不自己更新。");
    const readonly = this.readonlyText();
    if (readonly) return done("error", readonly);
    const client = this.client;
    if (!client || !this.channels) return done("error", "现在连不上服务器，更新不了。");
    const version = channelVersion(this.channels, this.channel(), SELF);
    if (!version) return done("error", "这个通道里没有平台。");
    if (compareVersions(version, this.options.version) <= 0) return done("ok", `平台 ${this.options.version} 已是最新。`);
    const task: TaskView = { kind: "update", version, phase: "manifest", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, reused: 0 };
    this.selfTask = task;
    this.selfResult = null;
    this.changed();
    try {
      const r = await this.installer.install(SELF, version, client, (p: InstallProgress) => {
        Object.assign(task, p);
        this.changed();
      });
      this.selfInstalledThisRun = true;
      const reused = r.reused ? `（${r.reused} 个文件本机已经有了，没有重新下载）` : "";
      this.selfResult = { tone: "ok", text: `已装好 ${version}${reused}` };
    } catch (err) {
      this.selfResult = { tone: "error", text: `平台没更新成功：${this.failed(err)}` };
    } finally {
      this.selfTask = null;
      this.changed();
    }
  }

  /**
   * 重启平台 (after an update) or 打开那个 (an older platform running while apps\platform has a newer one, when the
   * entry could not forward): the installed platform starts — from its real version folder, as the tools do
   * (launch.ts), so switching `current` later never meets a folder in use through the junction — and this one quits.
   * Not the entry: it still has the old files until the new platform brings them over, so it would only forward.
   * Only when clicked (AGENTS.md, constraint 6), and not while something is being installed. The tools started from
   * here are detached and keep running.
   */
  async restartSelf(): Promise<void> {
    const refuse = (text: string) => {
      this.selfResult = { tone: "error", text };
      this.changed();
    };
    if (this.place.kind === "dev") return refuse("这是从源码启动的开发版，不从这里重启。");
    if (this.selfTask || this.tasks.size) return refuse("正在安装或更新，等它做完再重启平台。");
    const exe = this.installedSelfExe();
    let file: string;
    try {
      if (!exe || !existsSync(exe)) throw new Error("missing");
      file = realpathSync(exe);
    } catch {
      return refuse(`${this.installer.toolDir(SELF)} 里没有装好的平台，先点「更新平台」。`);
    }
    const spec: LaunchSpec = { file, args: restartArgs(this.options.argv, this.options.pid ?? process.pid), cwd: dirname(file), env: startEnv(this.options.env) };
    try {
      if (!this.options.restart) throw new Error("这里不能重启");
      await this.options.restart(spec);
    } catch (err) {
      refuse(`没能重启平台：${message(err)}`);
    }
  }

  async dismissSelf(what: "result"): Promise<void> {
    if (what === "result") this.selfResult = null;
    this.changed();
  }

  // ---- 环境 (environment.ts): only looking, and links to the official pages

  private envChecker: EnvironmentChecker | null = null;

  /** The last check of what the tools run on, or a new one (重新检测: `fresh`). */
  async environment(fresh = false): Promise<EnvironmentView> {
    // Studio's own SDK, when it is installed, tells an outdated Claude Code as Studio's 设置 → 模型 does.
    this.envChecker ??= new EnvironmentChecker(() => ({ env: this.options.env, sdkClaudeCodeVersion: studioSdkClaudeCodeVersion(this.programs().studio?.dir) }));
    return this.envChecker.check(fresh);
  }

  /** 去下载: the item's official page (the platform's own list, https only) in the system browser. */
  async openDownload(id: string): Promise<void> {
    const url = downloadUrl(id);
    if (url) await this.options.shell.openExternal?.(url);
  }

  /** 复制: Claude Code's PowerShell install command. */
  async copyInstallCommand(): Promise<void> {
    this.options.shell.copyText?.(CLAUDE_INSTALL_COMMAND);
  }

  /** Where platform.json is (for the settings page). */
  settingsFile(): string {
    return platformFile(this.options.env);
  }
}
