import { isAbsolute, join, relative, resolve } from "node:path";
import { amoHome, amoLocalHome, AccountError, clearAccount, login, logout, platformFile, programsFile, readAccount, readJsonFile, register, serverInfo, type Account, type Env, type Protector } from "@amo-studio/account";
import { PlatformClient } from "./client.js";
import { Installer, type InstallProgress, type ProgramsFile } from "./installer.js";
import { channelVersion, compareVersions, PlatformError, type Channels, type Manifest } from "./manifest.js";
import { planLaunch, startDetached, type LaunchSpec } from "./launch.js";
import { channelFromArgs, readSettings, updateSettings } from "./settings.js";
import { foldersInUse, runningExePaths, studioHealth } from "./system.js";
import type { Channel, OpenResult, PlatformCalls, PlatformView, RegisterForm, RegisterResult, ServerCheck, StudioHealthView, TaskView, ToolView } from "./view.js";

// AMO 平台's state and actions, without Electron (main.ts wires it to the window, the tray and the dialogs; the tests
// drive it directly). One account (the team server's), the channel's tools, and what is installed here.

/** The tools the platform knows by id; others a server lists are shown under their manifest's name. */
const KNOWN: Record<string, { name: string; desc: string }> = {
  studio: { name: "AMO Studio", desc: "工作台：看板、任务、和模型的会话。自带 AMO 便签和 Reviewer。" },
  reviewer: { name: "AMO Reviewer（独立版）", desc: "Git Review 和查看器，可以单独用。" },
  notes: { name: "AMO 便签（独立版）", desc: "随手记，托盘常驻，可以单独用。" },
};
const ORDER = ["studio", "reviewer", "notes"];
/** Listed by the server but not a tool to install from here (the platform updates itself later, step 3). */
const HIDDEN = new Set(["platform"]);

export interface PlatformShell {
  pickFolder(title: string, start: string | null): Promise<string | null>;
  openPath(path: string): Promise<void>;
  setOpenAtLogin(on: boolean): void;
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
  private readonly listeners = new Set<(v: PlatformView) => void>();
  private readonly argChannel: Channel | null;

  constructor(private readonly options: PlatformOptions) {
    this.argChannel = channelFromArgs(options.argv);
    this.installer = new Installer({
      appsDir: join(amoLocalHome(options.env), "apps"),
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
      testMode: this.options.testMode,
      account: this.account ? { server: this.account.server, name: this.account.name } : null,
      loginError: this.loginError,
      loggingIn: this.loggingIn,
      servers: settings.recentServers,
      lastName: settings.lastName,
      channel,
      channelFromArgs: this.argChannel !== null,
      connection: this.connection,
      tools,
      dirs: { apps: this.installer.appsDir, studioData: settings.studioDataDir, settings: amoHome(this.options.env) },
      openAtLogin: settings.openAtLogin,
    };
  }

  // ---- start, account

  /** Reads the saved login, cleans up after any install that stopped half way, and asks the server. */
  async init(): Promise<void> {
    for (const tool of this.installer.tools()) {
      try {
        this.installer.repair(tool);
      } catch {
        // a folder in use: left for the next time
      }
    }
    this.account = await readAccount({ env: this.options.env, ...(this.options.protector ? { protector: this.options.protector } : {}) });
    this.client = this.account ? new PlatformClient(this.account.server, this.account.key, this.options.fetch) : null;
    if (this.account) {
      const s = readSettings(this.options.env);
      if (s.openAtLogin) this.options.shell.setOpenAtLogin(true);
    }
    this.changed();
    await this.refresh();
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
    this.loginError = why;
    this.changed();
  }

  private failed(err: unknown): string {
    if (err instanceof PlatformError && err.code === "unauthorized") {
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
    this.changed();
    try {
      const channels = await client.channels();
      const channel = this.channel();
      for (const id of new Set([...Object.keys(channels.stable), ...Object.keys(channels.test)])) {
        const v = channelVersion(channels, channel, id);
        if (!v || HIDDEN.has(id) || this.manifests.has(`${id}@${v}`)) continue;
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
      const reused = r.reused ? `（${r.reused} 个文件和上一版一样，没有重新下载）` : "";
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
    const plan = planLaunch(tool, this.programs()[tool], { studioDataDir: readSettings(this.options.env).studioDataDir, env: this.options.env, name: this.toolName(tool).replace(/（独立版）$/, "") });
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
    this.options.shell.setOpenAtLogin(on);
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

  async openPath(which: "apps" | "studioData" | "settings"): Promise<void> {
    const v = this.view();
    const path = which === "apps" ? v.dirs.apps : which === "settings" ? v.dirs.settings : v.dirs.studioData;
    if (path) await this.options.shell.openPath(path);
  }

  /** Where platform.json is (for the settings page). */
  settingsFile(): string {
    return platformFile(this.options.env);
  }
}
