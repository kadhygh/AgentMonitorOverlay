import { useEffect, useState, type FormEvent } from "react";
import { browserAccounts, browserServer, rememberBrowserAccount, shell } from "./env.js";
import type { Identity } from "./session.js";
import { RelayClient, RelayClientError, type Health, type SavedAccount, type ShellInfo } from "./shared.js";

// The first screen after the loader: who to log in as (saved accounts, password filled in), or a new account. In the
// desktop client it is also where an update waits: the loader found a newer client on the service and stopped here, so
// updating is one click and the window reloads into it — no restart.

const errorText = (err: unknown) => (err instanceof RelayClientError || err instanceof Error ? err.message : String(err));

export function Login({ onSignedIn }: { onSignedIn: (me: Identity) => void }) {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const server = info?.server ?? (shell ? "" : browserServer());
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [role, setRole] = useState("");
  const [invite, setInvite] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shell) void shell.info().then(setInfo);
  }, []);

  useEffect(() => {
    if (!server) return;
    const client = new RelayClient(server);
    client
      .health()
      .then((h) => (setHealth(h), setHealthError(null)))
      .catch((err) => setHealthError(errorText(err)));
    void (shell ? shell.accounts() : Promise.resolve(browserAccounts())).then((all) => {
      const here = all.filter((a) => a.server === client.server).sort((a, b) => b.lastUsed - a.lastUsed);
      setAccounts(here);
      const last = here[0];
      if (last) {
        setName(last.name);
        setPassword(last.password ?? "");
      }
    });
  }, [server]);

  const pick = (a: SavedAccount) => {
    setMode("login");
    setName(a.name);
    setPassword(a.password ?? "");
    setError(null);
  };

  const forget = async (a: SavedAccount) => {
    await shell?.forgetAccount(a.server, a.name);
    setAccounts((list) => list.filter((x) => x !== a));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== password2) return setError("两次输入的密码不一样");
    setBusy(true);
    try {
      const client = new RelayClient(server);
      const res = mode === "register" ? await client.register(name.trim(), password, { role: role.trim(), passphrase: invite || undefined }) : await client.login(name.trim(), password);
      const me: Identity = { server: client.server, name: res.name, role: res.role, key: res.key, service: health?.name ?? "AMO 中转" };
      if (shell) {
        await shell.saveAccount({ server: client.server, name: res.name, password: remember ? password : null });
        await shell.signedIn({ server: client.server, name: res.name, key: res.key });
      } else {
        rememberBrowserAccount(client.server, res.name);
        try {
          sessionStorage.setItem("amo-relay.session", JSON.stringify(me));
        } catch {
          // no session storage: the next reload asks again
        }
      }
      onSignedIn(me);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark">中</span>
          <div>
            <h1>{health?.name ?? "AMO 中转"}</h1>
            <p className="muted">和团队直接沟通，AI 也能把要确认的事发给对方</p>
          </div>
        </div>

        {info?.update && <UpdateBanner info={info} />}

        {healthError && (
          <div className="notice error">
            连不上服务器 {server}：{healthError}
            {shell && (
              <button type="button" className="link" onClick={() => shell!.changeServer()}>
                换一个地址
              </button>
            )}
          </div>
        )}

        {mode === "login" && accounts.length > 0 && (
          <div className="saved">
            {accounts.map((a) => (
              <span key={a.name} className={`saved-chip ${a.name === name ? "on" : ""}`}>
                <button type="button" onClick={() => pick(a)}>
                  <span className="avatar small">{a.name.slice(0, 1)}</span>
                  {a.name}
                  {a.password ? <span className="muted tiny">已存密码</span> : null}
                </button>
                {shell && (
                  <button type="button" className="x" title="不再记住这个账号" onClick={() => void forget(a)}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <form onSubmit={(e) => void submit(e)} className="form">
          <label>
            名字
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" placeholder="团队里大家认得的名字" autoFocus required maxLength={32} />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={4} />
          </label>
          {mode === "register" && (
            <>
              <label>
                再输一次密码
                <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={4} />
              </label>
              <label>
                负责什么 <span className="muted tiny">（可不填，AI 会看这个来决定问谁）</span>
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="比如：程序 · 战斗" maxLength={60} />
              </label>
              {health?.invite && (
                <label>
                  邀请口令
                  <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
                </label>
              )}
            </>
          )}
          {shell && (
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              记住密码
            </label>
          )}
          {error && <div className="notice error">{error}</div>}
          <button className="primary" disabled={busy || !server || !!healthError}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>

        <div className="login-foot">
          {mode === "login" ? (
            <button type="button" className="link" onClick={() => (setMode("register"), setError(null), setPassword(""))}>
              没有账号？注册一个
            </button>
          ) : (
            <button type="button" className="link" onClick={() => (setMode("login"), setError(null))}>
              已有账号，去登录
            </button>
          )}
          <span className="muted tiny">
            {server || "未设置服务器"}
            {shell && (
              <>
                {" · "}
                <button type="button" className="link tiny" onClick={() => shell!.changeServer()}>
                  更换
                </button>
                {" · 客户端 "}
                {info?.contentVersion}
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A newer client on the service: update here (download, switch, reload) or keep going with this one. */
export function UpdateBanner({ info, compact = false }: { info: ShellInfo; compact?: boolean }) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = info.update!;

  useEffect(() => {
    shell?.onUpdateProgress(setProgress);
  }, []);

  if (update.needShell) {
    return (
      <div className="notice update">
        新版本 {update.latest} 需要重新下载客户端。
        <button type="button" className="link" onClick={() => shell?.openExternal(info.server)}>
          打开下载页
        </button>
      </div>
    );
  }
  const start = async () => {
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      await shell!.applyUpdate();
    } catch (err) {
      setProgress(null);
      setError(errorText(err));
    }
  };
  return (
    <div className={`notice update ${compact ? "compact" : ""}`}>
      {progress ? (
        <div className="update-progress">
          正在更新到 {update.latest}…
          <div className="bar">
            <div style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <>
          <span>
            有新版本 <b>{update.latest}</b>
            {!compact && <span className="muted">（现在是 {update.current ?? "—"}）</span>}
          </span>
          <button type="button" className="primary small" onClick={() => void start()}>
            立即更新
          </button>
        </>
      )}
      {error && <div className="error tiny">更新失败：{error}</div>}
    </div>
  );
}
