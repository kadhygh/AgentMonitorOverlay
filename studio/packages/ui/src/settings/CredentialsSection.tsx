import { useEffect, useState } from "react";
import type { CredentialStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 模型凭据: which keys the models need and whether they are stored. API keys come from old AMO's settings;
// the Claude subscription token is pasted here (from `claude setup-token`) and kept in the Windows Credential Manager.

export function CredentialsSection({ link }: { link: HostLink }) {
  const [list, setList] = useState<CredentialStatus[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    call(link, "GET /api/credentials")
      .then(setList)
      .catch(() => undefined);
  }, [link]);

  if (!list?.length) return null;
  return (
    <section className="settings-section" aria-label="模型凭据">
      <span className="settings-heading">模型凭据</span>
      <span className="settings-hint">只显示是否已保存，不显示内容。DeepSeek、GLM 的 Key 沿用旧 AMO 设置里保存的那份。</span>
      {list.map((c) => (
        <CredentialRow key={c.id} link={link} credential={c} onChange={setList} onMessage={setMessage} />
      ))}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="credential-message">
          {message.text}
        </span>
      )}
    </section>
  );
}

function CredentialRow({
  link,
  credential,
  onChange,
  onMessage,
}: {
  link: HostLink;
  credential: CredentialStatus;
  onChange(list: CredentialStatus[]): void;
  onMessage(m: { text: string; error?: boolean } | null): void;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const name = credential.usedBy.join("、");

  async function run(fn: () => Promise<CredentialStatus[]>, done: string) {
    setBusy(true);
    onMessage(null);
    try {
      onChange(await fn());
      setSecret("");
      onMessage({ text: done });
    } catch (err) {
      onMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="credential" data-testid="credential" data-id={credential.id}>
      <div className="settings-row">
        <span className="settings-label">{name}</span>
        <span className={`credential-state${credential.saved ? " saved" : ""}`}>{credential.saved ? "已保存" : "未设置"}</span>
      </div>
      {credential.writable && (
        <>
          <span className="settings-hint">
            在终端运行 <code>claude setup-token</code>，按提示用你的 Claude 账号登录，把最后打印出的令牌粘贴到这里。令牌只存进 Windows 凭据管理器，Studio
            启动 Claude 时放进它的环境变量，不写任何文件。
          </span>
          <div className="settings-row">
            <input
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={credential.saved ? "粘贴新令牌以替换" : "sk-ant-oat01-…"}
              aria-label={`${name} 令牌`}
            />
            <button
              type="button"
              className="btn-primary small"
              disabled={busy || !secret.trim()}
              onClick={() => void run(() => call(link, "PUT /api/credentials/:id", { id: credential.id }, { secret }), `已保存 ${name} 令牌`)}
            >
              保存
            </button>
            {credential.saved && (
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy}
                onClick={() => void run(() => call(link, "DELETE /api/credentials/:id", { id: credential.id }), `已删除 ${name} 令牌`)}
              >
                删除
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
