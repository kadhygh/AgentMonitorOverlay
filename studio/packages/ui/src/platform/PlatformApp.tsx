import { useEffect, useRef, useState, type FormEvent } from "react";
import { AccountPage, Face } from "./AccountPage.js";
import { bridge, call, formatBytes, openTool, serverLabel, type Channel, type OpenResult, type PlatformView, type RegisterResult, type ServerCheck, type TaskView, type ToolView } from "./bridge.js";
import { EnvironmentPage } from "./EnvironmentPage.js";

// AMO 平台's window (platform.html, 2026-10-28; prototype https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9): the login
// page (with 注册 for people without an account) until there is an account, then 工具 / 环境 / 目录 / 设置, and 账号 at the
// foot of the pages (2026-10-28: the account out of 设置, with the profile editing that left the relay client). Everything it shows comes from the main process
// (platform:view) and every button is a call back to it; the page keeps only which page is open.
// The prototype's 更新 page (per-tool update modes, updates.json) is step 3 and not here yet.

type Page = "tools" | "environment" | "dirs" | "settings" | "account";

const PAGES: Array<[Page, string]> = [
  ["tools", "工具"],
  ["environment", "环境"],
  ["dirs", "目录"],
  ["settings", "设置"],
];

export function PlatformApp() {
  const [view, setView] = useState<PlatformView | null>(null);
  const [page, setPage] = useState<Page>("tools");
  /** Why the 目录 page was opened for them (Studio without its data dir). */
  const [dirNotice, setDirNotice] = useState<string | null>(null);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.view().then(setView);
    const offView = b.onView(setView);
    const offNotice = b.onNotice((n) => {
      if (n.reason === "need-studio-dir") {
        setPage("dirs");
        setDirNotice(n.message);
      }
    });
    return () => {
      offView();
      offNotice();
    };
  }, []);

  // Logged out (退出登录 is on 账号): the next login or registration starts on 工具.
  const loggedIn = !!view?.account;
  useEffect(() => {
    if (!loggedIn) setPage("tools");
  }, [loggedIn]);

  if (!bridge()) return <div className="pf-empty">这个页面要在 AMO 平台里打开。</div>;
  if (!view) return <div className="pf-empty">正在读取…</div>;

  const needStudioDir = (message: string) => {
    setPage("dirs");
    setDirNotice(message);
  };

  return (
    <div className="pf-root">
      <TitleBar view={view} onSelf={() => setPage("settings")} />
      {view.account ? (
        <div className="pf-main">
          <nav className="pf-nav" aria-label="页面">
            {PAGES.map(([id, label]) => (
              <button key={id} type="button" className="pf-nav-item" aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
                {label}
              </button>
            ))}
            <span className="pf-spacer" />
            <NavAccount view={view} current={page === "account"} onOpen={() => setPage("account")} />
            <div className="pf-nav-foot">
              平台 {view.version} · {view.channel === "test" ? "测试通道" : "稳定通道"}
            </div>
          </nav>
          <main className="pf-content">
            {page === "tools" && <ToolsPage view={view} onNeedStudioDir={needStudioDir} />}
            {page === "environment" && <EnvironmentPage />}
            {page === "dirs" && <DirsPage view={view} notice={dirNotice} onNoticeDone={() => setDirNotice(null)} />}
            {page === "settings" && <SettingsPage view={view} />}
            {page === "account" && <AccountPage view={view} />}
          </main>
        </div>
      ) : (
        <LoginPage view={view} />
      )}
    </div>
  );
}

/** The title bar's quiet line about the platform's own update (设置 → 平台更新 has the rest); null when there is none. */
function selfHint(view: PlatformView): string | null {
  const s = view.self;
  if (s.task) return "正在更新平台…";
  if (s.standing === "update") return `平台有新版 ${s.available}`;
  if (s.standing === "restart") return `重启平台换成 ${s.installed}`;
  if (s.standing === "newer-here") return `有更新的平台 ${s.installed}`;
  return null;
}

function TitleBar({ view, onSelf }: { view: PlatformView; onSelf: () => void }) {
  const c = view.connection;
  const hint = view.account ? selfHint(view) : null;
  const server = view.account ? serverLabel(view.account.server) : null;
  const status =
    !server || c.state === "idle"
      ? null
      : c.state === "online"
        ? { cls: "ok", mark: "●", text: `服务器在线 · ${server}` }
        : c.state === "checking"
          ? { cls: "dim", mark: "◐", text: `正在连接 · ${server}` }
          : { cls: "warn", mark: "!", text: `连不上服务器 · ${server}` };
  return (
    <header className="pf-titlebar">
      <img className="pf-logo" src="./icon.svg" alt="" aria-hidden="true" />
      <span className="pf-title">AMO 平台</span>
      {status && (
        <span className={`pf-conn ${status.cls}`} title={c.message ?? undefined} data-testid="pf-connection">
          <span aria-hidden="true">{status.mark}</span> {status.text}
        </span>
      )}
      {view.testMode && <span className="pf-tag">测试模式</span>}
      <span className="pf-spacer" />
      {hint && (
        <button type="button" className="pf-self-hint" onClick={onSelf} title="在「设置 → 平台更新」里看" data-testid="pf-self-hint">
          <span aria-hidden="true">{view.self.task ? "◐" : "!"}</span> {hint}
        </button>
      )}
      <div className="pf-winbtns">
        <button type="button" aria-label="最小化" title="最小化" onClick={() => bridge()?.windowAction("minimize")}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 5.5H9.5" stroke="currentColor" fill="none" />
          </svg>
        </button>
        <button type="button" aria-label="关到托盘" title="关到托盘（平台继续在托盘里）" onClick={() => bridge()?.windowAction("close")}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" fill="none" />
          </svg>
        </button>
      </div>
    </header>
  );
}

/** 账号 at the foot of the pages: the face and the name as the team sees them (the profile, once read). */
function NavAccount({ view, current, onOpen }: { view: PlatformView; current: boolean; onOpen: () => void }) {
  const name = view.account?.name ?? "";
  const profile = view.profile.data;
  const nick = profile?.nick ?? "";
  return (
    <button type="button" className="pf-nav-item pf-nav-me" aria-current={current ? "page" : undefined} onClick={onOpen} title="账号：昵称、头像、负责什么，退出登录" data-testid="pf-nav-account">
      <Face name={name} nick={nick} avatar={profile?.avatar ?? null} size="small" />
      <span className="pf-nav-me-text">
        <span className="pf-nav-me-name">{nick || name}</span>
        <span className="pf-nav-me-sub">账号</span>
      </span>
    </button>
  );
}

// ---- 登录

/**
 * The register form asks the server (a moment after the address stops changing) whether it is there and wants the
 * invite passphrase; null while asking. `recheck` asks again (a passphrase refused that the form did not ask for).
 */
function useServerCheck(server: string): { check: ServerCheck | null; recheck: () => void } {
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const s = server.trim();
    setCheck(null);
    if (!s) return;
    let live = true;
    const timer = setTimeout(() => {
      void call("serverInfo", s)
        .catch((err: unknown): ServerCheck => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))
        .then((r) => live && setCheck(r));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [server, round]);
  return { check, recheck: () => setRound((n) => n + 1) };
}

function LoginPage({ view }: { view: PlatformView }) {
  // 注册 (10-28): the platform is the only place to log in, so people without an account (a new 策划) register here,
  // on the same page; the fields and wording are the relay client's.
  const [mode, setMode] = useState<"login" | "register">("login");
  const [server, setServer] = useState(view.servers[0] ? serverLabel(view.servers[0]) : "");
  const [name, setName] = useState(view.lastName ?? "");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [role, setRole] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const registerMode = mode === "register";
  const { check, recheck } = useServerCheck(registerMode ? server : "");
  const invite = check?.ok === true && check.invite;
  const busy = view.loggingIn || registering;

  const switchMode = (to: "login" | "register") => {
    setMode(to);
    setPassword("");
    setPassword2("");
    setRegisterError(null);
    // The name filled in from the last login is not the new account's; a name typed here goes along either way.
    if (to === "register" && name === view.lastName) setName("");
    if (to === "login" && !name.trim()) setName(view.lastName ?? "");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!registerMode) return void call("login", server, name, password).catch(() => undefined);
    if (password !== password2) return setRegisterError("两次输入的密码不一样");
    setRegisterError(null);
    setRegistering(true);
    void call("register", { server, name, password, role, ...(invite ? { passphrase } : {}) })
      .catch((err: unknown): RegisterResult => ({ ok: false, code: "error", message: err instanceof Error ? err.message : String(err) }))
      .then((r) => {
        // Done: the account is there and the page has moved on to 工具.
        setRegistering(false);
        if (r.ok) return;
        setRegisterError(r.message);
        if (r.code === "unauthorized" && !invite) recheck();
      });
  };

  return (
    <div className="pf-login">
      <form className="pf-login-card" onSubmit={submit} aria-label={registerMode ? "注册" : "登录"}>
        <h1 className="pf-h1">{registerMode ? "注册账号" : "登录 AMO 平台"}</h1>
        <p className="pf-hint">
          {registerMode
            ? "账号建在团队服务器（AMO 中转）上，和中转里用的是同一个账号。注册好就直接登录平台。"
            : "用团队服务器（AMO 中转）的账号登录。登录以后才能安装和更新工具；登录只存在这台电脑上，按你的 Windows 用户加密。"}
        </p>
        <label className="pf-label">
          服务器地址
          <input className="field" value={server} onChange={(e) => setServer(e.target.value)} placeholder="例如 172.16.8.85:47120" autoFocus={!server} spellCheck={false} />
        </label>
        {view.servers.length > 0 && (
          <div className="pf-recent" role="group" aria-label="最近用过的服务器">
            <span className="pf-hint">最近用过：</span>
            {view.servers.map((s) => (
              <button key={s} type="button" className="pf-chip" aria-pressed={serverLabel(s) === server.trim()} onClick={() => setServer(serverLabel(s))}>
                {serverLabel(s)}
              </button>
            ))}
          </div>
        )}
        {registerMode && server.trim() && <ServerCheckLine check={check} />}
        {registerMode ? (
          <>
            <label className="pf-label">
              名字
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="团队里大家认得的名字" maxLength={32} autoComplete="username" spellCheck={false} />
            </label>
            <div className="pf-pair">
              <label className="pf-label">
                密码
                <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 4 位" autoComplete="new-password" />
              </label>
              <label className="pf-label">
                再输一次密码
                <input className="field" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
            <label className="pf-label">
              <span>
                负责什么 <span className="pf-faint">（可不填，AI 会看这个来决定问谁）</span>
              </span>
              <input className="field" value={role} onChange={(e) => setRole(e.target.value)} placeholder="比如：程序 · 战斗" maxLength={60} spellCheck={false} />
            </label>
            {invite && (
              <label className="pf-label">
                <span>
                  邀请口令 <span className="pf-faint">（这台服务器设了口令，问管服务器的人要）</span>
                </span>
                <input className="field" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} spellCheck={false} />
              </label>
            )}
            {registerError && (
              <p className="form-error" role="alert">
                {registerError}
              </p>
            )}
            <button type="submit" className="btn-primary pf-login-btn" disabled={busy || !server.trim() || !name.trim() || !password || check === null}>
              {registering ? "正在注册…" : "注册并登录"}
            </button>
          </>
        ) : (
          <>
            <label className="pf-label">
              名字
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!!server && !name} spellCheck={false} />
            </label>
            <label className="pf-label">
              密码
              <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!server && !!name} />
            </label>
            {view.loginError && (
              <p className="form-error" role="alert">
                {view.loginError}
              </p>
            )}
            <button type="submit" className="btn-primary pf-login-btn" disabled={busy || !server.trim() || !name.trim()}>
              {view.loggingIn ? "正在登录…" : "登录"}
            </button>
          </>
        )}
        <div className="pf-login-foot">
          {registerMode ? (
            <button type="button" className="pf-link" onClick={() => switchMode("login")} disabled={busy}>
              已有账号，去登录
            </button>
          ) : (
            <button type="button" className="pf-link" onClick={() => switchMode("register")} disabled={busy}>
              没有账号？注册一个
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Under the address while registering: whether the server is there, its name, whether it wants the passphrase. */
function ServerCheckLine({ check }: { check: ServerCheck | null }) {
  if (!check)
    return (
      <p className="pf-server-check dim" role="status">
        ◐ 正在问服务器…
      </p>
    );
  if (!check.ok)
    return (
      <p className="pf-server-check warn" role="status">
        ! {check.message}
      </p>
    );
  return (
    <p className="pf-server-check ok" role="status" data-testid="pf-server-check">
      ✓ 服务器在线{check.name ? ` · ${check.name}` : ""}
      {check.invite ? " · 注册要邀请口令" : ""}
    </p>
  );
}

// ---- 工具

function ToolsPage({ view, onNeedStudioDir }: { view: PlatformView; onNeedStudioDir: (message: string) => void }) {
  const offline = view.connection.state === "offline";
  return (
    <div className="pf-page">
      <div>
        <h1 className="pf-h1">工具</h1>
        <p className="pf-hint">团队服务器上{view.channel === "test" ? "测试通道" : "稳定通道"}里的工具，各自安装、各自更新。更新不会关掉正在用的工具，下次打开就是新版。</p>
      </div>
      <RootBanner view={view} />
      {offline && (
        <div className="pf-banner warn" role="status">
          <span>! 连不上服务器：{view.connection.message}。已经装好的工具照样能打开，「⋯」里的回到上个版本、卸载也能用。</span>
          <button type="button" className="btn-ghost pf-small" onClick={() => void call("refresh")}>
            重试
          </button>
        </div>
      )}
      {view.tools.length === 0 && <p className="pf-hint">{view.connection.state === "checking" ? "正在读取服务器上的工具…" : "服务器上还没有发布工具。"}</p>}
      {view.tools.map((t) => (
        <ToolRow key={t.id} tool={t} online={view.connection.state === "online"} writable={view.root.writable} onNeedStudioDir={onNeedStudioDir} />
      ))}
    </div>
  );
}

/**
 * The platform's folder (2026-10-28: the tools go where the platform was unpacked, no administrator rights): one it
 * cannot write to stops installing and updating, and says to move the folder; a network or removable drive only warns.
 */
function RootBanner({ view }: { view: PlatformView }) {
  const r = view.root;
  if (!r.writable)
    return (
      <div className="pf-banner error" role="alert" data-testid="pf-root-issue">
        <span>
          ! 这个文件夹不能写入（<code className="pf-path inline">{r.path}</code>），平台装不了工具也更新不了。把整个文件夹移到能写的位置（比如 D:\TOOLS）再打开。
        </span>
      </div>
    );
  if (r.drive === "network")
    return (
      <div className="pf-banner warn" role="status" data-testid="pf-root-issue">
        <span>
          ! 平台在网络盘上（<code className="pf-path inline">{r.path}</code>）：工具共用的文件在这里多半没法硬链接，每个工具会各复制一份；网络断了平台和工具都打不开。建议把整个文件夹移到本机硬盘（比如 D:\TOOLS）。
        </span>
      </div>
    );
  if (r.drive === "removable")
    return (
      <div className="pf-banner warn" role="status" data-testid="pf-root-issue">
        <span>
          ! 平台在可移动盘上（<code className="pf-path inline">{r.path}</code>）：盘拔掉后平台和工具都打不开；有的盘不支持硬链接，工具共用的文件会各复制一份。建议把整个文件夹移到本机硬盘（比如 D:\TOOLS）。
        </span>
      </div>
    );
  return null;
}

function statusLine(t: ToolView): { tone: "ok" | "warn" | "idle"; text: string } {
  const running = t.running ? " · 正在运行" : "";
  switch (t.standing) {
    case "not-installed":
      return { tone: "idle", text: t.available ? `○ 没装 · 服务器上是 ${t.available}` : "○ 没装 · 这个通道里没有它" };
    case "update":
      return { tone: "warn", text: `! ${t.installed} · 有新版 ${t.available}${running}` };
    case "ahead":
      return { tone: "ok", text: `✓ ${t.installed} · 比这个通道的 ${t.available} 新${running}` };
    case "not-in-channel":
      return { tone: "ok", text: `✓ ${t.installed} · 这个通道里没有它${running}` };
    default:
      return { tone: "ok", text: `✓ ${t.installed} · 已是最新${running}` };
  }
}

/** Studio's card (2026-10-29): whether its Host (后台) runs, with how many sessions and which version, when installed. */
function studioLine(t: ToolView): string | null {
  const s = t.studio;
  if (!s || !t.installed) return null;
  if (!s.hostUp) return "○ 后台没在运行";
  const sessions = s.sessions === null ? "看不到有几个会话在跑" : s.sessions === 0 ? "没有会话在跑" : `${s.sessions} 个会话进行中`;
  const version = s.version === null ? "" : s.version === "dev" ? " · 后台是开发版" : ` · 后台版本 ${s.version}`;
  return `✓ 后台在运行 · ${sessions}${version}`;
}

/** Why 重启 Studio is offered, or why it cannot be clicked now; null when there is nothing to say. */
function studioRestartLine(t: ToolView): string | null {
  const s = t.studio;
  if (!s || !t.installed) return null;
  switch (s.restart) {
    case "ready":
      return `! 正在运行的后台还是 ${s.version}，已装的是 ${t.installed}：重启 Studio 才会用上。`;
    case "busy":
      return `! 正在运行的后台还是 ${s.version}，已装的是 ${t.installed}。${s.sessions} 个会话进行中，停下后再重启。`;
    case "unsupported":
      return "这个后台是更早的 Studio 启动的，看不到它的版本，也不能从这里重启。";
    default:
      return null;
  }
}

// One bar that only moves forward (用户 2026-10-29: it rose, fell back and rose again — the sliding busy block before and
// after the download, then the real width from 0): empty until the download, its bytes while it runs, full while
// switching. The sliding block only for what has no amount at all (uninstalling, going back to a kept version).
function BarFill({ task }: { task: TaskView }) {
  const fraction = task.phase === "manifest" || task.phase === "linking" ? 0 : task.phase === "downloading" ? (task.totalBytes > 0 ? Math.min(1, task.doneBytes / task.totalBytes) : 1) : task.kind === "install" || task.kind === "update" ? 1 : null;
  if (fraction === null) return <div className="pf-bar-fill busy" />;
  return <div className="pf-bar-fill" style={{ width: `${(100 * fraction).toFixed(1)}%` }} />;
}

function taskLine(task: TaskView): string {
  switch (task.phase) {
    case "manifest":
      return "正在读取清单…";
    case "linking":
      return `正在准备 · ${task.reused} 个文件本机已经有了，直接带过来`;
    case "downloading":
      return task.totalBytes === 0 ? "没有要下载的文件" : `正在下载 · ${formatBytes(task.doneBytes)} / ${formatBytes(task.totalBytes)} · ${task.doneFiles} / ${task.totalFiles} 个文件`;
    case "switching":
      return task.kind === "rollback" ? `正在回到 ${task.version}…` : `正在切换到 ${task.version}…`;
    case "removing":
      return "正在卸载…";
  }
}

function ToolRow({ tool: t, online, writable, onNeedStudioDir }: { tool: ToolView; online: boolean; writable: boolean; onNeedStudioDir: (message: string) => void }) {
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const busy = t.task !== null;
  const status = statusLine(t);
  const studio = studioLine(t);
  const studioRestart = studioRestartLine(t);
  const short = t.name.replace(/（独立版）$/, "");

  const open = () => {
    setOpenError(null);
    void openTool(t.id).then((r) => {
      if (r.ok) return;
      if (r.reason === "need-studio-dir") onNeedStudioDir(r.message);
      else setOpenError(r.message);
    });
  };

  const actions: Array<{ label: string; kind: "primary" | "plain" | "quiet"; run: () => void; disabled?: boolean; title?: string }> = [];
  // A folder it cannot write to: nothing to install or update (RootBanner says why); offline: nothing to fetch.
  const cannot = !writable ? "这个文件夹不能写入，见上面的提示" : !online ? "现在连不上服务器" : undefined;
  if (t.standing === "not-installed" && t.available) actions.push({ label: "安装", kind: "plain", run: () => void call("install", t.id), disabled: !!cannot, title: cannot });
  if (t.standing === "update") actions.push({ label: `更新到 ${t.available}`, kind: "primary", run: () => void call("install", t.id), disabled: !!cannot, title: cannot });
  if (t.installed) actions.push({ label: "打开", kind: "plain", run: open });
  // 关闭 (2026-10-29, the user): the tool quits its own way — Studio asks first when sessions are at work, as its 完全退出 does.
  if (t.installed && t.running)
    actions.push({
      label: "关闭",
      kind: "plain",
      run: () => {
        setOpenError(null);
        void (call("close", t.id) as Promise<OpenResult>).then((r) => !r.ok && setOpenError(r.message));
      },
      title: t.id === "studio" ? "完全退出 Studio（连后台一起）；有会话在跑或远程在用时它会先问你" : `退出 ${short}`,
    });
  // 重启 Studio (2026-10-29): the Host is older than what is installed; never while sessions are at work (AGENTS.md, 6).
  const st = t.studio;
  if (st && (st.restart === "ready" || st.restart === "busy" || st.restarting))
    actions.unshift({
      label: st.restarting ? "正在重启…" : "重启 Studio",
      kind: "primary",
      run: () => void call("restartStudio"),
      disabled: st.restarting || st.restart === "busy",
      title: st.restart === "busy" ? `${st.sessions} 个会话进行中，停下后再重启` : "关掉正在运行的 Studio 和它的后台，再用已装的版本打开",
    });

  // The rest in 「⋯」 (2026-10-28, the user: going back a version is not shown on the card): 换成, 回到, 卸载.
  const more: MenuItem[] = [];
  if (t.standing === "ahead") more.push({ label: `换成 ${t.available}`, note: cannot ?? "装这个通道里的版本", run: () => void call("install", t.id), disabled: !!cannot });
  if (t.rollbackTo) more.push({ label: `回到 ${t.rollbackTo}`, note: "上一个装过的版本，还在这台电脑上，不用下载", run: () => void call("rollback", t.id) });
  if (t.installed) more.push({ label: "卸载…", note: t.running ? "正在运行，先关掉它再卸载" : "会先问一下；数据和设置不受影响", run: () => setConfirmUninstall(true), danger: true });

  const showNotes = !!t.notes && (t.standing === "update" || t.standing === "not-installed");

  return (
    <section className="pf-tool" aria-label={t.name} data-testid={`tool-${t.id}`}>
      <div className="pf-tool-head">
        <div className="pf-mark" aria-hidden="true">
          {t.id === "notes" ? "便" : t.name.replace(/^AMO\s*/, "").slice(0, 1).toUpperCase()}
        </div>
        <div className="pf-tool-text">
          <div className="pf-tool-name">{t.name}</div>
          {t.desc && <div className="pf-hint">{t.desc}</div>}
          <div className={`pf-status ${status.tone}`} data-testid={`tool-${t.id}-status`}>
            {status.text}
          </div>
          {studio && (
            <div className="pf-hint" data-testid="tool-studio-host">
              {studio}
            </div>
          )}
          {studioRestart && (
            <div className={`pf-hint${t.studio?.restart === "unsupported" ? "" : " pf-warn-text"}`} data-testid="tool-studio-restart">
              {studioRestart}
            </div>
          )}
          {t.hint && <div className="pf-hint">{t.hint}</div>}
        </div>
        <div className="pf-actions">
          {actions.map((a) => (
            <button key={a.label} type="button" className={a.kind === "primary" ? "btn-primary" : "btn-ghost"} disabled={busy || a.disabled} title={a.title ?? (a.disabled ? "现在连不上服务器" : undefined)} onClick={a.run}>
              {a.label}
            </button>
          ))}
          {more.length > 0 && <MoreMenu items={more} label={short} disabled={busy} />}
        </div>
      </div>

      {t.task && (
        <div className="pf-progress" role="status" aria-label={`${short} 进度`}>
          <div className="pf-bar" aria-hidden="true">
            <BarFill task={t.task} />
          </div>
          <span className="pf-hint">{taskLine(t.task)}</span>
        </div>
      )}

      {t.result && (
        <div className={`pf-result ${t.result.tone}`} role={t.result.tone === "error" ? "alert" : "status"} data-testid={`tool-${t.id}-result`}>
          <span>
            {t.result.tone === "ok" ? "✓ " : "! "}
            {t.result.text}
          </span>
          <button type="button" className="pf-x" aria-label="知道了" title="知道了" onClick={() => void call("dismiss", t.id)}>
            ×
          </button>
        </div>
      )}
      {openError && (
        <div className="pf-result error" role="alert">
          <span>! {openError}</span>
        </div>
      )}

      {confirmUninstall && (
        <div className="pf-confirm" role="group" aria-label={`卸载 ${short}`}>
          <span>
            卸载 {short}？{t.installed}
            {t.rollbackTo ? ` 和留着的 ${t.rollbackTo}` : ""} 都会删掉，数据和设置不受影响。
          </span>
          <button
            type="button"
            className="pf-danger"
            onClick={() => {
              setConfirmUninstall(false);
              void call("uninstall", t.id);
            }}
          >
            卸载
          </button>
          <button type="button" className="btn-ghost pf-small" onClick={() => setConfirmUninstall(false)}>
            取消
          </button>
        </div>
      )}

      {showNotes && (
        <div className="pf-tool-foot">
          <details className="pf-notes" open={t.standing === "update"}>
            <summary>{t.available} 改了什么</summary>
            <div className="pf-notes-text">{t.notes}</div>
          </details>
        </div>
      )}
    </section>
  );
}

interface MenuItem {
  label: string;
  /** A second, quieter line: what it does, or why it cannot now. */
  note?: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A tool's 「⋯」: the actions not needed every day, in a small menu under the button (closes on a click outside or Esc). */
function MoreMenu({ items, label, disabled }: { items: MenuItem[]; label: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="pf-menu-wrap" ref={wrap}>
      <button type="button" className="btn-ghost pf-more-btn" aria-label={`${label} 的更多操作`} title={`更多：${items.map((i) => i.label.replace(/…$/, "")).join("、")}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="pf-menu" role="menu" aria-label={`${label} 的更多操作`}>
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={`pf-menu-item${i.danger ? " danger" : ""}`}
              disabled={i.disabled}
              onClick={() => {
                setOpen(false);
                i.run();
              }}
            >
              <span className="pf-menu-label">{i.label}</span>
              {i.note && <span className="pf-menu-note">{i.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 目录

function DirsPage({ view, notice, onNoticeDone }: { view: PlatformView; notice: string | null; onNoticeDone: () => void }) {
  const studioError = view.tools.find((t) => t.id === "studio")?.result;
  useEffect(() => {
    if (notice && view.dirs.studioData) onNoticeDone();
  }, [notice, view.dirs.studioData, onNoticeDone]);
  return (
    <div className="pf-page">
      <div>
        <h1 className="pf-h1">目录</h1>
        <p className="pf-hint">改了以后，下次打开对应的工具时生效。Reviewer 和便签放在哪，平台自己知道，不用设。</p>
      </div>
      <section className="pf-dir" aria-label="工具装在哪">
        <div className="pf-dir-head">
          <span className="pf-tool-name">工具装在哪</span>
          <span className="pf-spacer" />
          <button type="button" className="pf-link" onClick={() => void call("openPath", "root")}>
            打开
          </button>
        </div>
        <code className="pf-path" data-testid="pf-root">
          {view.dirs.root}
        </code>
        <p className="pf-hint">工具装在平台所在的文件夹里；要换位置，把整个文件夹移过去（先退出平台和从它打开的工具），再打开里面的 AMO Platform.exe。</p>
        <p className="pf-hint">
          里面的 apps 放着每个工具的每个版本，current 指向正在用的那个；更新是装一个新版本再把 current 指过去，留着上一版方便回滚。平台自己的新版也装在 apps\platform 里，外面的 AMO Platform.exe 会跟着换成新版。
        </p>
      </section>
      <section className={`pf-dir${notice && !view.dirs.studioData ? " attention" : ""}`} aria-label="Studio 数据目录">
        {notice && !view.dirs.studioData && (
          <p className="pf-dir-notice" role="alert">
            ! {notice}
          </p>
        )}
        <div className="pf-dir-head">
          <span className="pf-tool-name">Studio 数据目录</span>
          <span className="pf-spacer" />
          <button type="button" className="btn-ghost pf-small" onClick={() => void call("pickStudioDataDir")}>
            {view.dirs.studioData ? "更改…" : "选择文件夹…"}
          </button>
          {view.dirs.studioData && (
            <button type="button" className="pf-link" onClick={() => void call("openPath", "studioData")}>
              打开
            </button>
          )}
        </div>
        <code className={`pf-path${view.dirs.studioData ? "" : " unset"}`} data-testid="pf-studio-data">
          {view.dirs.studioData ?? "还没设"}
        </code>
        <p className="pf-hint">会话、项目、设置都存在这里，升级不会碰它。第一次从平台打开 Studio 之前要先设；选你现在用的数据目录（源码启动时是 studio\.data），就能接着用原来的会话和项目。同一时间只开一份 Studio。</p>
        {studioError?.tone === "error" && (
          <p className="form-error" role="alert">
            {studioError.text}
          </p>
        )}
      </section>
    </div>
  );
}

// ---- 设置

/**
 * Where the running platform is, in words (2026-10-28: the platform and its tools stay in the folder it was unpacked
 * to; its updates go to apps\platform there, and the AMO Platform.exe people double-click follows them).
 */
function selfPlaceLine(view: PlatformView): string {
  const s = view.self;
  if (s.place === "dev") return "开发版（从源码启动），不自己更新。";
  const entry = s.entry ?? "AMO Platform.exe";
  const cut = entry.lastIndexOf("\\");
  const name = entry.slice(cut + 1);
  const folder = entry.slice(0, Math.max(cut, 0));
  // Paths inside the platform's folder said relative to it (the folder itself is on 目录), else in full.
  const inFolder = (p: string) => (folder && p.toLowerCase().startsWith(`${folder.toLowerCase()}\\`) ? p.slice(folder.length + 1) : null);
  const home = inFolder(s.home) ? `同一个文件夹的 ${inFolder(s.home)}` : s.home;
  if (s.place === "installed") {
    const here = s.dir && inFolder(s.dir) ? `${inFolder(s.dir)} 里的版本（平台的文件夹：${folder}）` : `${s.dir} 里的版本`;
    if (s.entryState === "current") return `正在运行 ${here}。${name} 已经换成这一版，以后还是双击它打开平台。`;
    if (s.entryState === "failed") return `正在运行 ${here}。${name} 这次没换成新版（文件可能正被占用），下次启动平台时再换；现在双击它也会转到新版。`;
    return `正在运行 ${here}。`;
  }
  // Only when the entry could not hand over to the newer version by itself.
  if (s.standing === "newer-here") return `这个是旧的 ${view.version}。${home} 里有更新的平台，点「打开那个」换过去。`;
  if (s.standing === "restart") return `新版已经装进${home}。点「重启平台」换过去，之后 ${name} 也会换成新版。`;
  return `从 ${entry} 运行。新版会装进${home}，之后 ${name} 跟着换成新版，以后还是双击它打开。`;
}

function selfStatus(view: PlatformView): { tone: "ok" | "warn" | "idle"; text: string } | null {
  const s = view.self;
  switch (s.standing) {
    case "dev":
      return null;
    case "update":
      return { tone: "warn", text: `! 有新版 ${s.available}` };
    case "restart":
      return { tone: "ok", text: `✓ ${s.installed} 已装好，点「重启平台」换成新版` };
    case "newer-here":
      return { tone: "warn", text: `! 有更新的平台 ${s.installed}，打开那个` };
    default:
      return s.available ? { tone: "ok", text: s.available === view.version ? "✓ 已是最新" : `✓ 已是最新（通道里是 ${s.available}）` } : view.connection.state === "online" ? { tone: "idle", text: "○ 这个通道里还没有平台" } : null;
  }
}

/**
 * 平台更新 (2026-10-28, the user: people download the platform once, then it updates itself): the version running, a new
 * one with its notes and 更新平台; once installed 重启平台 — only when clicked (AGENTS.md, constraint 6); the tools it
 * started keep running. The development build only says it does not update itself.
 */
function SelfSection({ view }: { view: PlatformView }) {
  const s = view.self;
  const status = selfStatus(view);
  const online = view.connection.state === "online";
  const busy = s.task !== null || view.tools.some((t) => t.task !== null);
  return (
    <section className="pf-section" aria-label="平台更新" data-testid="pf-self">
      <h2 className="pf-h2">平台更新</h2>
      <div className="pf-row">
        <span>当前版本 {view.version}</span>
        {status && (
          <span className={`pf-status ${status.tone}`} data-testid="pf-self-status">
            {status.text}
          </span>
        )}
        <span className="pf-spacer" />
        {s.standing === "update" && (
          <button type="button" className="btn-primary" disabled={busy || !online || !view.root.writable} title={!view.root.writable ? "这个文件夹不能写入，见「工具」页上的提示" : online ? undefined : "现在连不上服务器"} onClick={() => void call("updateSelf")}>
            更新平台
          </button>
        )}
        {s.standing === "restart" && (
          <button type="button" className="btn-primary" disabled={busy} title={busy ? "正在安装或更新，等它做完" : undefined} onClick={() => void call("restartSelf")}>
            重启平台
          </button>
        )}
        {s.standing === "newer-here" && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void call("restartSelf")}>
            打开那个
          </button>
        )}
      </div>
      <p className="pf-hint" data-testid="pf-self-place">
        {selfPlaceLine(view)}
      </p>
      {(s.standing === "restart" || s.standing === "newer-here") && <p className="pf-hint">重启只换平台自己：从平台打开的工具不会关，登录和设置照旧。</p>}
      {s.task && (
        <div className="pf-progress" role="status" aria-label="平台更新进度">
          <div className="pf-bar" aria-hidden="true">
            <BarFill task={s.task} />
          </div>
          <span className="pf-hint">{taskLine(s.task)}</span>
        </div>
      )}
      {s.result && (
        <div className={`pf-result ${s.result.tone}`} role={s.result.tone === "error" ? "alert" : "status"} data-testid="pf-self-result">
          <span>
            {s.result.tone === "ok" ? "✓ " : "! "}
            {s.result.text}
          </span>
          <button type="button" className="pf-x" aria-label="知道了" title="知道了" onClick={() => void call("dismissSelf", "result")}>
            ×
          </button>
        </div>
      )}
      {s.notes && (s.standing === "update" || s.standing === "restart") && (
        <details className="pf-notes pf-self-notes" open={s.standing === "update"}>
          <summary>{s.available} 改了什么</summary>
          <div className="pf-notes-text">{s.notes}</div>
        </details>
      )}
      {!view.root.writable && s.standing === "update" && (
        <p className="form-error" role="alert">
          这个文件夹不能写入（{view.root.path}），平台更新不了。把整个文件夹移到能写的位置（比如 D:\TOOLS）再打开。
        </p>
      )}
    </section>
  );
}

const CHANNELS: Array<[Channel, string, string]> = [
  ["stable", "稳定", "团队确认过的版本。"],
  ["test", "测试", "刚发布的版本，先拿到，可能有问题。"],
];

const THEMES: Array<[PlatformView["theme"], string]> = [
  ["light", "浅色"],
  ["dark", "深色"],
  ["system", "跟随系统"],
];

function SettingsPage({ view }: { view: PlatformView }) {
  // The team server and 退出登录 are on 账号 (2026-10-28).
  return (
    <div className="pf-page">
      <h1 className="pf-h1">设置</h1>

      <SelfSection view={view} />

      <section className="pf-section" aria-label="更新通道">
        <h2 className="pf-h2">更新通道</h2>
        <div className="pf-row">
          <div role="radiogroup" aria-label="更新通道" className="pf-seg">
            {CHANNELS.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={view.channel === id} disabled={view.channelFromArgs} onClick={() => view.channel !== id && void call("setChannel", id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="pf-hint">{CHANNELS.find(([id]) => id === view.channel)![2]}</span>
        </div>
        {view.channelFromArgs && <p className="pf-hint">这次是用启动参数 --channel {view.channel} 打开的，以它为准；不带参数打开时才按这里的选择。</p>}
      </section>

      <section className="pf-section" aria-label="主题">
        <h2 className="pf-h2">主题</h2>
        <div className="pf-row">
          <div role="radiogroup" aria-label="主题" className="pf-seg">
            {THEMES.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={view.theme === id} onClick={() => view.theme !== id && void call("setTheme", id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="pf-hint">平台的窗口和托盘菜单都跟着变。</span>
        </div>
      </section>

      <section className="pf-section" aria-label="启动">
        <h2 className="pf-h2">启动</h2>
        <label className="pf-check">
          <input type="checkbox" checked={view.openAtLogin} onChange={(e) => void call("setOpenAtLogin", e.target.checked)} data-testid="pf-login-start" />
          开机时启动平台（只在托盘里，不弹窗口）
        </label>
        <p className="pf-hint">关掉窗口后平台留在托盘里。从平台打开的工具不再各放一个托盘图标，都在平台的托盘菜单里（右键）：打开、关闭、显示便签；单击托盘图标打开便签或 Studio，在菜单最下面选。</p>
      </section>

      <section className="pf-section last" aria-label="关于">
        <h2 className="pf-h2">关于</h2>
        <div className="pf-row">
          <span>AMO 平台 {view.version}</span>
          <span className="pf-spacer" />
          <button type="button" className="pf-link" onClick={() => void call("openPath", "settings")}>
            打开设置文件夹
          </button>
        </div>
        <p className="pf-hint">登录和设置存在 {view.dirs.settings}（account.json、platform.json、programs.json）。</p>
      </section>
    </div>
  );
}
