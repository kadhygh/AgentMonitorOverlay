import { useEffect, useState, type FormEvent } from "react";
import { bridge, call, formatBytes, openTool, serverLabel, type Channel, type PlatformView, type RegisterResult, type ServerCheck, type TaskView, type ToolView } from "./bridge.js";

// AMO 平台's window (platform.html, 2026-10-28; prototype https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9): the login
// page (with 注册 for people without an account) until there is an account, then 工具 / 目录 / 设置. Everything it shows comes from the main process
// (platform:view) and every button is a call back to it; the page keeps only which page is open.
// The prototype's 更新 page (per-tool update modes, updates.json) is step 3 and not here yet.

type Page = "tools" | "dirs" | "settings";

const PAGES: Array<[Page, string]> = [
  ["tools", "工具"],
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

  // Logged out (退出登录 is on 设置): the next login or registration starts on 工具.
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
      <TitleBar view={view} />
      {view.account ? (
        <div className="pf-main">
          <nav className="pf-nav" aria-label="页面">
            {PAGES.map(([id, label]) => (
              <button key={id} type="button" className="pf-nav-item" aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
                {label}
              </button>
            ))}
            <span className="pf-spacer" />
            <div className="pf-nav-foot">
              平台 {view.version} · {view.channel === "test" ? "测试通道" : "稳定通道"}
            </div>
          </nav>
          <main className="pf-content">
            {page === "tools" && <ToolsPage view={view} onNeedStudioDir={needStudioDir} />}
            {page === "dirs" && <DirsPage view={view} notice={dirNotice} onNoticeDone={() => setDirNotice(null)} />}
            {page === "settings" && <SettingsPage view={view} />}
          </main>
        </div>
      ) : (
        <LoginPage view={view} />
      )}
    </div>
  );
}

function TitleBar({ view }: { view: PlatformView }) {
  const c = view.connection;
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
      {offline && (
        <div className="pf-banner warn" role="status">
          <span>! 连不上服务器：{view.connection.message}。已经装好的工具照样能打开、回滚、卸载。</span>
          <button type="button" className="btn-ghost pf-small" onClick={() => void call("refresh")}>
            重试
          </button>
        </div>
      )}
      {view.tools.length === 0 && <p className="pf-hint">{view.connection.state === "checking" ? "正在读取服务器上的工具…" : "服务器上还没有发布工具。"}</p>}
      {view.tools.map((t) => (
        <ToolRow key={t.id} tool={t} online={view.connection.state === "online"} onNeedStudioDir={onNeedStudioDir} />
      ))}
    </div>
  );
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

function studioLine(t: ToolView): string | null {
  const s = t.studio;
  if (!s?.hostUp) return null;
  const sessions = s.sessions === null ? "有几个会话在跑看不到（Studio 版本较旧）" : s.sessions === 0 ? "没有会话在跑" : `有 ${s.sessions} 个会话在跑`;
  return `Studio 的后台在运行 · ${sessions}`;
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

function ToolRow({ tool: t, online, onNeedStudioDir }: { tool: ToolView; online: boolean; onNeedStudioDir: (message: string) => void }) {
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const busy = t.task !== null;
  const status = statusLine(t);
  const studio = studioLine(t);
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
  if (t.standing === "not-installed" && t.available) actions.push({ label: "安装", kind: "plain", run: () => void call("install", t.id), disabled: !online });
  if (t.standing === "update") actions.push({ label: `更新到 ${t.available}`, kind: "primary", run: () => void call("install", t.id), disabled: !online });
  if (t.installed) actions.push({ label: "打开", kind: "plain", run: open });

  const more: typeof actions = [];
  if (t.standing === "ahead") more.push({ label: `换成 ${t.available}`, kind: "quiet", run: () => void call("install", t.id), disabled: !online, title: "装这个通道里的版本" });
  if (t.rollbackTo) more.push({ label: `回到 ${t.rollbackTo}`, kind: "quiet", run: () => void call("rollback", t.id), title: "换回上一个装过的版本（还留在这台电脑上，不用下载）" });
  if (t.installed) more.push({ label: "卸载", kind: "quiet", run: () => setConfirmUninstall(true), title: t.running ? "正在运行时不能卸载" : undefined });

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
          {studio && <div className="pf-hint">{studio}</div>}
          {t.hint && <div className="pf-hint">{t.hint}</div>}
        </div>
        <div className="pf-actions">
          {actions.map((a) => (
            <button key={a.label} type="button" className={a.kind === "primary" ? "btn-primary" : "btn-ghost"} disabled={busy || a.disabled} title={a.title ?? (a.disabled ? "现在连不上服务器" : undefined)} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {t.task && (
        <div className="pf-progress" role="status" aria-label={`${short} 进度`}>
          <div className="pf-bar" aria-hidden="true">
            <div className={`pf-bar-fill${t.task.phase === "downloading" && t.task.totalBytes > 0 ? "" : " busy"}`} style={t.task.phase === "downloading" && t.task.totalBytes > 0 ? { width: `${Math.min(100, (100 * t.task.doneBytes) / t.task.totalBytes).toFixed(1)}%` } : undefined} />
          </div>
          <span className="pf-hint">{taskLine(t.task)}</span>
        </div>
      )}

      {t.result && (
        <div className={`pf-result ${t.result.tone}`} role={t.result.tone === "error" ? "alert" : "status"} data-testid={`tool-${t.id}-result`}>
          <span>
            {t.result.tone === "error" ? "! " : "✓ "}
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

      {(showNotes || more.length > 0) && (
        <div className="pf-tool-foot">
          {showNotes ? (
            <details className="pf-notes" open={t.standing === "update"}>
              <summary>{t.available} 改了什么</summary>
              <div className="pf-notes-text">{t.notes}</div>
            </details>
          ) : (
            <span className="pf-spacer" />
          )}
          <div className="pf-more">
            {more.map((a) => (
              <button key={a.label} type="button" className="pf-link" disabled={busy || a.disabled} title={a.title} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
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
          <button type="button" className="pf-link" onClick={() => void call("openPath", "apps")}>
            打开
          </button>
        </div>
        <code className="pf-path">{view.dirs.apps}</code>
        <p className="pf-hint">每个工具每个版本一个文件夹，current 指向正在用的那个；更新是装一个新文件夹再把 current 指过去，留着上一版方便回滚。</p>
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

const CHANNELS: Array<[Channel, string, string]> = [
  ["stable", "稳定", "团队确认过的版本。"],
  ["test", "测试", "刚发布的版本，先拿到，可能有问题。"],
];

function SettingsPage({ view }: { view: PlatformView }) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  return (
    <div className="pf-page">
      <h1 className="pf-h1">设置</h1>

      <section className="pf-section" aria-label="团队服务器">
        <h2 className="pf-h2">团队服务器</h2>
        <div className="pf-row">
          <code className="pf-path">{view.account ? serverLabel(view.account.server) : ""}</code>
          <span className="pf-hint">已登录：{view.account?.name}</span>
          <span className="pf-spacer" />
          {confirmLogout ? (
            <>
              <span className="pf-hint">退出后要重新登录才能安装和更新。</span>
              <button type="button" className="btn-ghost pf-small" onClick={() => void call("logout")}>
                退出登录
              </button>
              <button type="button" className="pf-link" onClick={() => setConfirmLogout(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="btn-ghost pf-small" onClick={() => setConfirmLogout(true)}>
              退出登录…
            </button>
          )}
        </div>
        <p className="pf-hint">换服务器或账号：先退出登录，登录页上能选最近用过的 3 个服务器。已经装好的工具不受影响。</p>
      </section>

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

      <section className="pf-section" aria-label="启动">
        <h2 className="pf-h2">启动</h2>
        <label className="pf-check">
          <input type="checkbox" checked={view.openAtLogin} onChange={(e) => void call("setOpenAtLogin", e.target.checked)} data-testid="pf-login-start" />
          开机时启动平台（只在托盘里，不弹窗口）
        </label>
        <p className="pf-hint">关掉窗口后平台留在托盘里；右键托盘图标可以打开工具或退出平台。</p>
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
