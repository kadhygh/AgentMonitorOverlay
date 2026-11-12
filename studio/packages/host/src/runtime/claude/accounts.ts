import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import type { ClaudeAccount, ClaudeAccountLogin, ClaudeAccountsState, Id } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { localClaudeSignedIn } from "./claude-login.js";
import { requireClaudeCode } from "./executable.js";
import { hostOnlyEnv } from "../agent-env.js";

// Claude 多账号 (2026-11-03, the user's call: 方案 C). Claude Code keeps one login per config dir — its documented way to
// stay signed in to several accounts is CLAUDE_CONFIG_DIR (code.claude.com/docs/en/authentication, "Log in with
// multiple accounts"); there is no switcher inside it. So every account Studio adds is a dir of its own under
// ~/.claude-accounts (outside the program folder: AGENTS.md rule 2), signed in there with `claude auth login`.
//
// What makes switching mid-conversation possible: an added account's dir links (directory junctions, no admin needed)
// to the default dir's `projects` — transcripts and the agent's memory —, and to its skills, plugins, agents and
// commands; CLAUDE.md and settings.json are copied over before each start (a file link would need admin or Developer
// Mode, and an editor that saves by renaming breaks a hard link). The default dir stays the one place these live: a
// session on any account resumes the same transcript, and the person's terminal `claude` is untouched.
//
// Only the person switches (设置 → 模型, or 额度 at the bottom left), and not while a Claude session is at work (the
// runtime's guard). Studio never moves to another account by itself when one runs out (the user, 2026-11-03).

const KEY = "settings:claude-accounts";
export const DEFAULT_ACCOUNT = "default";

/** Dirs an added account shares with the default one (only those the default dir has, `projects` always). */
const SHARED_DIRS = ["projects", "skills", "plugins", "agents", "commands", "output-styles", "file-history", "todos"];
/** Files copied from the default dir before each start (kept as the default dir has them). */
const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json"];
/** A sign-in the person did not finish: let go after this long. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface SavedAccount {
  id: Id;
  /** The person's name; "" = the email (or a stand-in). */
  label: string;
  dir: string;
  email?: string | null;
  plan?: string | null;
}

interface Saved {
  current: Id;
  accounts: SavedAccount[];
}

/** Where a Claude process runs: its config dir, and whether CLAUDE_CONFIG_DIR is set for it (see ClaudeHome). */
export interface AccountHome {
  id: Id;
  dir: string;
  explicit: boolean;
}

export interface ClaudeAccountsOptions {
  /** The person's own Claude Code dir (~/.claude or their CLAUDE_CONFIG_DIR). */
  defaultDir: string;
  /** Whether they set CLAUDE_CONFIG_DIR themselves (otherwise the CLI is left to find ~/.claude and ~/.claude.json). */
  defaultExplicit: boolean;
  /** Where added accounts' dirs go (default ~/.claude-accounts). */
  root?: string;
  /** The Claude Code to run `auth login` / `auth status` with (default: the one sessions run on). */
  exe?: () => string;
  /** Variables the CLI starts from (default process.env). */
  baseEnv?: NodeJS.ProcessEnv;
}

/** The account list, the current account, signing in, and linking an account's dir to the default one. */
export class ClaudeAccounts {
  private readonly logins = new Map<Id, { child: ChildProcess; state: ClaudeAccountLogin; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<() => void>();
  /** Set by the Claude runtime: why switching is not possible now (a session at work), and what to do before it. */
  private guard: { blocked(): string | null; beforeSwitch(from?: Id, to?: Id): Promise<void> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: ClaudeAccountsOptions,
  ) {}

  get root(): string {
    return this.options.root ?? join(homedir(), ".claude-accounts");
  }

  setGuard(guard: { blocked(): string | null; beforeSwitch(from?: Id, to?: Id): Promise<void> }): void {
    this.guard = guard;
  }

  /** Called on every change (list, current, a sign-in's progress). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  private read(): Saved {
    let saved: Partial<Saved> = {};
    try {
      saved = JSON.parse(this.store.getKv(KEY)?.value ?? "{}") as Partial<Saved>;
    } catch {
      saved = {};
    }
    const added = (Array.isArray(saved.accounts) ? saved.accounts : []).filter((a): a is SavedAccount => !!a && typeof a.id === "string" && a.id !== DEFAULT_ACCOUNT && typeof a.dir === "string");
    const own = (Array.isArray(saved.accounts) ? saved.accounts : []).find((a) => a?.id === DEFAULT_ACCOUNT);
    // The default account's dir is always the person's own (it may have moved with CLAUDE_CONFIG_DIR).
    const accounts: SavedAccount[] = [{ id: DEFAULT_ACCOUNT, label: own?.label ?? "", dir: this.options.defaultDir, email: own?.email ?? null, plan: own?.plan ?? null }, ...added];
    const current = typeof saved.current === "string" && accounts.some((a) => a.id === saved.current) ? saved.current : DEFAULT_ACCOUNT;
    return { current, accounts };
  }

  private write(saved: Saved): void {
    this.store.setKv(KEY, JSON.stringify(saved));
  }

  currentId(): Id {
    return this.read().current;
  }

  /** An account's name and the email `auth status` last gave (for host.log), or null when there is no such account. */
  describe(id: Id): { label: string; email: string | null } | null {
    const a = this.read().accounts.find((x) => x.id === id);
    return a ? { label: labelOf(a), email: a.email ?? null } : null;
  }

  /** How many accounts there are (one: everything looks as before multi-account). */
  count(): number {
    return this.read().accounts.length;
  }

  /** The current account's home, with an added account's shared parts brought up to date first. */
  currentHome(): AccountHome {
    const saved = this.read();
    const a = saved.accounts.find((x) => x.id === saved.current)!;
    return this.homeOf(a);
  }

  /** Every signed-in or not account's home, for reading quotas (no linking: nothing runs there). */
  homes(): Array<AccountHome & { label: string; current: boolean; name: string | null; email: string | null; plan: string | null }> {
    const saved = this.read();
    return saved.accounts.map((a) => {
      const explicit = a.id !== DEFAULT_ACCOUNT || this.options.defaultExplicit;
      const claude = claudeProfileOf(a.dir, explicit);
      return { id: a.id, dir: a.dir, explicit, label: labelOf(a), current: a.id === saved.current, name: claude.name, email: a.email ?? claude.email, plan: claude.plan ?? a.plan ?? null };
    });
  }

  private homeOf(a: SavedAccount): AccountHome {
    if (a.id === DEFAULT_ACCOUNT) return { id: a.id, dir: a.dir, explicit: this.options.defaultExplicit };
    try {
      linkShared(this.options.defaultDir, a.dir);
    } catch {
      // A dir that cannot be linked still signs in; its records are then its own.
    }
    return { id: a.id, dir: a.dir, explicit: true };
  }

  state(): ClaudeAccountsState {
    const saved = this.read();
    const accounts: ClaudeAccount[] = saved.accounts.map((a) => {
      const claude = claudeProfileOf(a.dir, a.id !== DEFAULT_ACCOUNT || this.options.defaultExplicit);
      return {
        id: a.id,
        label: labelOf(a),
        dir: a.dir,
        isDefault: a.id === DEFAULT_ACCOUNT,
        signedIn: localClaudeSignedIn(a.dir),
        email: a.email ?? claude.email,
        plan: a.plan ?? null,
        claudeName: claude.name,
        claudePlan: claude.plan,
        login: this.logins.get(a.id)?.state ?? null,
      };
    });
    return { current: saved.current, accounts, switchBlocked: this.guard?.blocked() ?? null };
  }

  // ---- changing ----------------------------------------------------------------------------------------------------

  /** 添加账号: a new dir linked to the default one, and its sign-in started (`signIn: false`: tests sign it in themselves). */
  add(label = "", { signIn = true }: { signIn?: boolean } = {}): Id {
    const saved = this.read();
    const id = `ca-${randomBytes(4).toString("hex")}`;
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true });
    linkShared(this.options.defaultDir, dir);
    saved.accounts.push({ id, label: label.trim().slice(0, 60), dir, email: null, plan: null });
    this.write(saved);
    if (signIn) this.login(id);
    else this.changed();
    return id;
  }

  rename(id: Id, label: string): void {
    const saved = this.read();
    const a = this.require(saved, id);
    a.label = label.trim().slice(0, 60);
    this.write(saved);
    this.changed();
  }

  /** 切换. The guard refuses while a Claude session is at work, and closes the idle processes of the old account. */
  async switchTo(id: Id): Promise<void> {
    const saved = this.read();
    const a = this.require(saved, id);
    if (saved.current === id) return;
    if (localClaudeSignedIn(a.dir) === false) throw Object.assign(new Error(`账号「${labelOf(a)}」还没登录，先登录再切换`), { code: "conflict" });
    const blocked = this.guard?.blocked();
    if (blocked) throw Object.assign(new Error(blocked), { code: "conflict" });
    await this.guard?.beforeSwitch(saved.current, id);
    const now = this.read();
    now.current = id;
    this.write(now);
    this.changed();
  }

  /** Removes an added account: its sign-in, its dir (links first: never what they point to). */
  remove(id: Id): void {
    const saved = this.read();
    const a = this.require(saved, id);
    if (a.id === DEFAULT_ACCOUNT) throw Object.assign(new Error("本机默认账号不能删除"), { code: "bad_request" });
    if (saved.current === id) throw Object.assign(new Error("正在使用的账号不能删除：先切换到别的账号"), { code: "conflict" });
    this.cancelLogin(id, false);
    removeAccountDir(this.root, a.dir);
    saved.accounts = saved.accounts.filter((x) => x.id !== id);
    this.write(saved);
    this.changed();
  }

  private require(saved: Saved, id: Id): SavedAccount {
    const a = saved.accounts.find((x) => x.id === id);
    if (!a) throw Object.assign(new Error(`没有这个 Claude 账号：${id}`), { code: "not_found" });
    return a;
  }

  // ---- signing in --------------------------------------------------------------------------------------------------

  /** The CLI's environment for an account: nothing Claude/Anthropic inherited, its dir when set explicitly. */
  private env(home: AccountHome): Record<string, string> {
    const base = this.options.baseEnv ?? process.env;
    const inherited = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k) && !hostOnlyEnv(k))) as Record<string, string>;
    return { ...inherited, ...(home.explicit ? { CLAUDE_CONFIG_DIR: home.dir } : {}), DISABLE_AUTOUPDATER: "1" };
  }

  /**
   * `claude auth login` for the account, in the background: it opens the browser and waits for the page to hand the
   * login back (checked 2026-11-03 with CLI 2.1.304: without a terminal it prints the page's address and "Paste code
   * here if prompted >", and reads that code from stdin). Done when it exits 0 with a login in the dir.
   */
  login(id: Id): void {
    const saved = this.read();
    const a = this.require(saved, id);
    if (this.logins.has(id)) return;
    const home = a.id === DEFAULT_ACCOUNT ? { id, dir: a.dir, explicit: this.options.defaultExplicit } : this.homeOf(a);
    const exe = (this.options.exe ?? requireClaudeCode)();
    const child = spawn(exe, ["auth", "login"], { env: this.env(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const state: ClaudeAccountLogin = { state: "waiting", url: null, error: null };
    let output = "";
    const onData = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-8000);
      const url = /https:\/\/\S+/.exec(output)?.[0] ?? null;
      if (url && url !== state.url) {
        state.url = url;
        this.changed();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      state.error = "登录超时（10 分钟内没有完成）";
      child.kill();
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    this.logins.set(id, { child, state, timer });
    const done = (code: number | null, err?: Error) => {
      const entry = this.logins.get(id);
      if (!entry || entry.child !== child) return;
      clearTimeout(timer);
      const signedIn = localClaudeSignedIn(a.dir) !== false;
      if (code === 0 && signedIn) {
        this.logins.delete(id);
        this.changed();
        void this.refresh(id);
        return;
      }
      const last = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Paste code/i.test(l)).pop();
      entry.state = { state: "failed", url: null, error: state.error ?? (err ? `启动 Claude Code 失败：${err.message}` : last ? `登录没有完成：${last}` : `登录没有完成（退出码 ${code ?? "无"}）`) };
      this.changed();
    };
    child.on("error", (err) => done(null, err));
    child.on("exit", (code) => done(code));
    this.changed();
  }

  /** The code the sign-in page shows, typed into the waiting `auth login`. */
  loginCode(id: Id, code: string): void {
    const entry = this.logins.get(id);
    const value = code.trim();
    if (!entry || entry.state.state !== "waiting") throw Object.assign(new Error("这个账号没有正在进行的登录"), { code: "conflict" });
    if (!value || value.length > 2000 || /\s/.test(value)) throw Object.assign(new Error("这不像登录页给的代码：应是一整串不含空格的字符"), { code: "bad_request" });
    entry.child.stdin?.write(`${value}\n`);
  }

  /** Stops a sign-in (or puts a failed one away). `dropNew`: a new account that never signed in goes too. */
  cancelLogin(id: Id, dropNew = true): void {
    const entry = this.logins.get(id);
    if (entry) {
      this.logins.delete(id);
      clearTimeout(entry.timer);
      if (entry.child.exitCode === null) entry.child.kill();
    }
    if (dropNew && id !== DEFAULT_ACCOUNT && localClaudeSignedIn(this.read().accounts.find((a) => a.id === id)?.dir ?? "") === false && this.currentId() !== id) {
      this.remove(id);
      return;
    }
    this.changed();
  }

  /** Email and plan from `claude auth status --json` (no model call). */
  async refresh(id: Id): Promise<void> {
    const saved = this.read();
    const a = this.require(saved, id);
    const home = a.id === DEFAULT_ACCOUNT ? { id, dir: a.dir, explicit: this.options.defaultExplicit } : this.homeOf(a);
    const status = await authStatus((this.options.exe ?? requireClaudeCode)(), this.env(home));
    if (!status) return;
    const now = this.read();
    const b = now.accounts.find((x) => x.id === id);
    if (!b) return;
    b.email = status.loggedIn ? (status.email ?? null) : null;
    b.plan = status.loggedIn ? (status.subscriptionType ?? null) : null;
    this.write(now);
    this.changed();
  }

  /** Lets every sign-in go (Host shutdown). */
  shutdown(): void {
    for (const [id, entry] of this.logins) {
      clearTimeout(entry.timer);
      if (entry.child.exitCode === null) entry.child.kill();
      this.logins.delete(id);
    }
  }
}

/**
 * The account as its Claude login knows it (2026-11-12, the user: 最好能看到账号的真正 Claude 名称): `oauthAccount` of the
 * `.claude.json` the CLI uses for the dir — the dir's own when CLAUDE_CONFIG_DIR is set for it, else ~/.claude.json.
 */
export function claudeProfileOf(dir: string, explicit: boolean): { name: string | null; email: string | null; plan: string | null } {
  try {
    const a = (JSON.parse(readFileSync(explicit ? join(dir, ".claude.json") : join(homedir(), ".claude.json"), "utf8")) as { oauthAccount?: Record<string, unknown> }).oauthAccount ?? {};
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { name: text(a.displayName) ?? text(a.fullName), email: text(a.emailAddress), plan: text(a.planDisplayName) };
  } catch {
    return { name: null, email: null, plan: null };
  }
}

function labelOf(a: SavedAccount): string {
  return a.label || a.email || (a.id === DEFAULT_ACCOUNT ? "本机默认账号" : "新账号");
}

/** `claude auth status --json` (CLI 2.1.268+): { loggedIn, email, subscriptionType, … }; null when it did not answer. */
export function authStatus(exe: string, env: Record<string, string>, timeoutMs = 20_000): Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string } | null> {
  return new Promise((resolveStatus) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(exe, ["auth", "status", "--json"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolveStatus(null);
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => (clearTimeout(timer), resolveStatus(null)));
    // `auth status` exits 1 when signed out, with the JSON all the same.
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const v = JSON.parse(out.slice(out.indexOf("{"))) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
        resolveStatus({ loggedIn: v.loggedIn === true, ...(typeof v.email === "string" ? { email: v.email } : {}), ...(typeof v.subscriptionType === "string" ? { subscriptionType: v.subscriptionType } : {}) });
      } catch {
        resolveStatus(null);
      }
    });
  });
}

const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * Links an added account's dir to the default one: SHARED_DIRS as directory junctions (`projects` made in the default
 * dir when missing), SHARED_FILES copied when they differ. A real dir already standing where a link goes is left as it
 * is when it holds anything (never deleted), and replaced by the link when empty.
 */
export function linkShared(defaultDir: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of SHARED_DIRS) {
    const src = join(defaultDir, name);
    if (name === "projects") mkdirSync(src, { recursive: true });
    if (!existsSync(src)) continue;
    const dst = join(dir, name);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dst);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(dst);
      } catch {
        target = "";
      }
      if (target && same(target, src)) continue;
      unlinkSync(dst);
    } else if (st?.isDirectory()) {
      if (readdirSync(dst).length) continue;
      rmdirSync(dst);
    } else if (st) {
      continue;
    }
    symlinkSync(src, dst, "junction");
  }
  for (const name of SHARED_FILES) {
    const src = join(defaultDir, name);
    if (!existsSync(src)) continue;
    const dst = join(dir, name);
    let differs = true;
    try {
      differs = !readFileSync(src).equals(readFileSync(dst));
    } catch {
      differs = true;
    }
    if (differs) copyFileSync(src, dst);
  }
}

/**
 * Deletes an added account's dir: only one inside `root`, its links taken away first (unlinking a junction leaves
 * what it points to alone), then the rest — the account's own login and settings.
 */
export function removeAccountDir(root: string, dir: string): void {
  const rel = relative(resolve(root), resolve(dir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
    } catch {
      // gone already
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
