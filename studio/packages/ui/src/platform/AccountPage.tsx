import { useEffect, useRef, useState, type FormEvent } from "react";
import { call, serverLabel, type PlatformView, type ProfilePatch, type ProfileSaveResult } from "./bridge.js";
import { avatarColor, squareImage } from "./profile.js";

// 账号 (2026-10-28, the user: the account out of 设置 into a page of its own, and editing the nickname, picture and 负责什么
// moved here from the relay client, which now only shows them). The team server's GET / PATCH /api/me, through the main
// process (Platform.loadProfile / saveProfile); 退出登录 moved here from 设置.

/** A face: the picture, or the initial (of the nickname, else the name) on a colour picked from the account name. */
export function Face({ name, nick, avatar, size }: { name: string; nick: string; avatar: string | null; size: "small" | "big" }) {
  if (avatar) return <img className={`pf-face ${size}`} src={avatar} alt="" />;
  return (
    <span className={`pf-face ${size}`} style={{ background: avatarColor(name) }} aria-hidden="true">
      {(nick || name).slice(0, 1)}
    </span>
  );
}

export function AccountPage({ view }: { view: PlatformView }) {
  const name = view.account?.name ?? "";
  const server = view.account ? serverLabel(view.account.server) : "";
  const p = view.profile;
  const data = p.data;
  const [nick, setNick] = useState(data?.nick ?? "");
  const [role, setRole] = useState(data?.role ?? "");
  const [avatar, setAvatar] = useState<string | null>(data?.avatar ?? null);
  /** Edited since the last save or read: what the server says no longer replaces the form. */
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Read again on coming here: someone may have changed it from another computer.
  useEffect(() => {
    void call("loadProfile").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (touched || !data) return;
    setNick(data.nick);
    setRole(data.role);
    setAvatar(data.avatar);
  }, [data, touched]);

  const edit = () => {
    setTouched(true);
    setResult(null);
  };
  const patch: ProfilePatch = {};
  if (data && nick.trim() !== data.nick) patch.nick = nick.trim();
  if (data && role.trim() !== data.role) patch.role = role.trim();
  if (data && avatar !== data.avatar) patch.avatar = avatar;
  const changed = touched && Object.keys(patch).length > 0;

  const pickImage = async (f: File) => {
    try {
      setAvatar(await squareImage(f, 128));
      edit();
    } catch {
      setResult({ tone: "error", text: "这个文件读不出图片，换一张 PNG 或 JPEG 试试" });
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setResult(null);
    void call("saveProfile", patch)
      .catch((err: unknown): ProfileSaveResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))
      .then((r) => {
        setSaving(false);
        if (!r.ok) return setResult({ tone: "error", text: r.message });
        setTouched(false);
        setResult({ tone: "ok", text: "已保存，团队里的人都会看到，AMO 中转里也是" });
      });
  };
  const undo = () => {
    setTouched(false);
    setResult(null);
    if (!data) return;
    setNick(data.nick);
    setRole(data.role);
    setAvatar(data.avatar);
  };
  const shown = nick.trim();

  return (
    <div className="pf-page">
      <div>
        <h1 className="pf-h1">账号</h1>
        <p className="pf-hint">团队服务器上的账号，AMO 中转里用的也是它。</p>
      </div>

      {p.state === "error" && (
        <div className="pf-banner warn" role="status" data-testid="pf-profile-error">
          <span>! 读不到资料：{p.message}</span>
          <button type="button" className="btn-ghost pf-small" onClick={() => void call("loadProfile")}>
            重试
          </button>
        </div>
      )}

      <section className="pf-section" aria-label="资料">
        <h2 className="pf-h2">资料</h2>
        <p className="pf-hint pf-section-hint">昵称、头像、负责什么，团队里的人都看得到；AMO 中转里也按这个显示，在那边改不了。</p>
        {data ? (
          <form className="pf-profile" onSubmit={save} aria-label="编辑资料">
            <div className="pf-profile-face">
              <button type="button" className="pf-face-pick" onClick={() => file.current?.click()} title="换一张图片（会裁成正方形）" aria-label="换头像">
                <Face name={name} nick={shown} avatar={avatar} size="big" />
                <span className="pf-face-hint" aria-hidden="true">
                  更换
                </span>
              </button>
              <div className="pf-face-acts">
                <button type="button" className="pf-link" onClick={() => file.current?.click()}>
                  上传图片
                </button>
                {avatar && (
                  <button
                    type="button"
                    className="pf-link"
                    onClick={() => {
                      setAvatar(null);
                      edit();
                    }}
                  >
                    用文字头像
                  </button>
                )}
              </div>
              <input
                ref={file}
                type="file"
                accept="image/*"
                hidden
                data-testid="pf-avatar-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void pickImage(f);
                }}
              />
            </div>
            <div className="pf-profile-fields">
              <div className="pf-profile-preview" data-testid="pf-profile-preview">
                <span className="pf-hint">别人看到的是</span>
                <b>
                  {shown || name}
                  {shown && <span className="pf-aka">({name})</span>}
                </b>
              </div>
              <label className="pf-label">
                <span>
                  昵称 <span className="pf-faint">（不填就显示账号名）</span>
                </span>
                <input className="field" value={nick} onChange={(e) => (setNick(e.target.value), edit())} maxLength={32} placeholder={name} spellCheck={false} />
              </label>
              <label className="pf-label">
                <span>
                  负责什么 <span className="pf-faint">（AI 会看这个决定问谁）</span>
                </span>
                <input className="field" value={role} onChange={(e) => (setRole(e.target.value), edit())} maxLength={60} placeholder="比如：程序 · 战斗" spellCheck={false} />
              </label>
              <div className="pf-row">
                <button type="submit" className="btn-primary" disabled={!changed || saving}>
                  {saving ? "正在保存…" : "保存"}
                </button>
                {changed && !saving && (
                  <button type="button" className="pf-link" onClick={undo}>
                    还原
                  </button>
                )}
                {result && (
                  <span className={`pf-status ${result.tone === "ok" ? "ok" : "error"}`} role={result.tone === "error" ? "alert" : "status"} data-testid="pf-profile-result">
                    {result.tone === "ok" ? "✓ " : "! "}
                    {result.text}
                  </span>
                )}
              </div>
            </div>
          </form>
        ) : (
          <p className="pf-hint">{p.state === "error" ? "读到资料以后才能改。" : "◐ 正在读取资料…"}</p>
        )}
      </section>

      <section className="pf-section last" aria-label="登录">
        <h2 className="pf-h2">登录</h2>
        <dl className="pf-facts">
          <dt>服务器</dt>
          <dd>
            <code className="pf-path inline" data-testid="pf-account-server">
              {server}
            </code>
            {data?.service ? <span className="pf-hint"> · 团队「{data.service}」</span> : null}
          </dd>
          <dt>账号名</dt>
          <dd data-testid="pf-account-name">
            {name} <span className="pf-hint">· 用来登录，不能改</span>
          </dd>
        </dl>
        <div className="pf-row">
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
    </div>
  );
}
