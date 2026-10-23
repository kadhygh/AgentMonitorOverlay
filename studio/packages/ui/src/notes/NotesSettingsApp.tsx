import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { DEFAULT_SCRATCHPAD_SHORTCUT, SCRATCHPAD_MAX_PAGES } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { ScratchpadIcon } from "../scratchpad/ScratchpadApp.js";
import { shortcutFromKey, shortcutLabel } from "../scratchpad/logic.js";
import { useScratchpad } from "../scratchpad/useScratchpad.js";
import { formatBytes, notesCall, type NotesInfo } from "./api.js";

// 便签设置 (2026-10-23): the 便签 program's own settings window, opened from its tray menu. The shortcut, the page count
// and 复制's line breaks (as 设置 → 便签 had them in Studio), starting with Windows, the work folder (where it is, what
// it takes, moving it, clearing its cache) and where the settings file is.

const NEWLINE_CHOICES = [
  { safe: false, label: "常规换行", hint: "保留原来的分行（去掉行尾空格和末尾空行）。粘贴到输入框、文档、聊天软件都按原样分行。" },
  { safe: true, label: "安全换行", hint: "把多行合成一行、用空格连接，粘贴进终端里的 CLI 时不会一换行就发出去。" },
] as const;

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

export function NotesSettingsApp() {
  const host = useHostState();
  return (
    <div className="ns-root">
      <header className="pad-head">
        <span className="pad-name">
          <ScratchpadIcon />
          便签设置
        </span>
        <span className="spacer" />
        <button type="button" className="pad-icon" aria-label="关闭设置" title="关闭" onClick={() => window.amo?.notes?.closeSettings()}>
          ×
        </button>
      </header>
      <div className="pad-rule" aria-hidden="true" />
      {host.kind === "ready" ? <Settings link={host.link} /> : <div className="pad-empty">{host.kind === "connecting" ? "正在读取…" : host.reason}</div>}
    </div>
  );
}

function Settings({ link }: { link: HostLink }) {
  const [info, setInfo] = useState<NotesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [freed, setFreed] = useState<number | null>(null);

  const load = useCallback(() => {
    notesCall(link, "GET", "")
      .then(setInfo)
      .catch((err: unknown) => setError(message(err)));
  }, [link]);
  useEffect(() => {
    load();
    // Sizes change as pages and images are added: read again whenever the window comes forward.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  async function run(fn: () => Promise<NotesInfo | (NotesInfo & { freed: number })>) {
    setBusy(true);
    setError(null);
    try {
      setInfo(await fn());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: Record<string, unknown>) => run(() => notesCall(link, "PATCH", "/settings", body));
  const open = (what: "folder" | "cache" | "home") => void notesCall(link, "POST", "/open", { what }).catch((err: unknown) => setError(message(err)));

  if (!info) return <div className="pad-empty">{error ?? "正在读取…"}</div>;
  const s = info.settings;
  const total = info.usage.pages + info.usage.images + info.usage.cache;

  return (
    <div className="ns-body">
      <ShortcutSection info={info} busy={busy} onSave={(shortcut) => void patch({ shortcut })} />
      <PagesSection link={link} />

      <section className="ns-section" aria-label="复制时的换行">
        <h2 className="ns-heading">复制时的换行</h2>
        <div role="radiogroup" aria-label="复制时的换行" className="ns-seg">
          {NEWLINE_CHOICES.map((c) => (
            <button key={c.label} type="button" role="radio" aria-checked={s.safeNewlines === c.safe} disabled={busy} onClick={() => s.safeNewlines !== c.safe && void patch({ safeNewlines: c.safe })} data-testid={c.safe ? "ns-newlines-safe" : "ns-newlines-normal"}>
              {c.label}
            </button>
          ))}
        </div>
        <p className="ns-hint">{NEWLINE_CHOICES.find((c) => c.safe === s.safeNewlines)!.hint}</p>
      </section>

      <section className="ns-section" aria-label="启动">
        <h2 className="ns-heading">启动</h2>
        <label className="ns-check">
          <input type="checkbox" checked={s.openAtLogin} disabled={busy} onChange={(e) => void patch({ openAtLogin: e.target.checked })} data-testid="ns-login" />
          开机时启动便签
        </label>
        <p className="ns-hint">只在托盘里待着，不弹出窗口；按快捷键或点托盘图标呼出。</p>
      </section>

      <section className="ns-section" aria-label="工作文件夹">
        <h2 className="ns-heading">工作文件夹</h2>
        <div className="ns-row">
          <span className="ns-path" title={info.folder} data-testid="ns-folder">
            {info.folder}
          </span>
          <button
            type="button"
            className="btn-ghost small"
            disabled={busy || !window.amo?.notes}
            onClick={() =>
              void window.amo?.notes
                ?.pickFolder(info.folder)
                .then((dir) => dir && setMoving(dir))
                .catch(() => undefined)
            }
          >
            更改…
          </button>
          <button type="button" className="btn-ghost small dim" onClick={() => open("folder")}>
            打开
          </button>
        </div>
        <p className="ns-hint">便签的每页内容和粘贴的图片都存在这里。默认在你的用户目录；换到别处时可以一键把现有内容迁移过去。</p>
        <div className="ns-usage">
          <div className="ns-usage-text">
            <span>
              共占用 <strong data-testid="ns-total">{formatBytes(total)}</strong>
            </span>
            <span className="ns-hint">
              便签内容 {formatBytes(info.usage.pages)} · 图片 {formatBytes(info.usage.images)} · 缓存 <span data-testid="ns-cache">{formatBytes(info.usage.cache)}</span>
            </span>
          </div>
          <button type="button" className="btn-ghost small dim" title={info.cacheDir} onClick={() => open("cache")}>
            打开临时文件夹
          </button>
          <button
            type="button"
            className="btn-ghost small"
            disabled={busy || info.usage.cache === 0}
            onClick={() =>
              void run(async () => {
                const r = await notesCall<NotesInfo & { freed: number }>(link, "POST", "/cache/clear");
                setFreed(r.freed);
                return r;
              })
            }
            data-testid="ns-clear-cache"
          >
            清理缓存
          </button>
        </div>
        <p className="ns-hint">
          {freed !== null ? `清理了 ${formatBytes(freed)}。` : ""}缓存是已经不在任何一页里的图片（删掉的、清空页面时留下的）和临时文件。清理不会动现有的便签和图片。
        </p>
      </section>

      <section className="ns-section last" aria-label="设置文件">
        <h2 className="ns-heading">设置文件</h2>
        <div className="ns-row">
          <span className="ns-path plain" title={info.settingsFile}>
            {info.settingsFile}
          </span>
          <button type="button" className="link-btn primary" onClick={() => open("home")}>
            打开所在文件夹
          </button>
        </div>
        <p className="ns-hint">设置总是存在用户目录里，换工作文件夹也不变。</p>
      </section>

      {error && (
        <p className="form-error ns-error" role="alert">
          {error}
        </p>
      )}
      {moving && (
        <MoveDialog
          from={info.folder}
          to={moving}
          onCancel={() => setMoving(null)}
          onConfirm={(move) =>
            void run(async () => {
              const next = await notesCall(link, "POST", "/folder", { path: moving, move });
              setMoving(null);
              return next;
            })
          }
          busy={busy}
          error={error}
        />
      )}
    </div>
  );
}

function ShortcutSection({ info, busy, onSave }: { info: NotesInfo; busy: boolean; onSave(shortcut: string): void }) {
  const [capturing, setCapturing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const shortcut = info.settings.shortcut;

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab") return;
    e.preventDefault();
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const got = shortcutFromKey(e);
    if ("pending" in got) return;
    if ("invalid" in got) {
      setInvalid(true);
      return;
    }
    e.currentTarget.blur();
    if (got.shortcut !== shortcut) onSave(got.shortcut);
  }

  const status = info.shortcut;
  const line = invalid
    ? { text: "需要 Ctrl、Alt 或 Win 加一个键，或者单独的 F1–F24", alert: true }
    : status.error
      ? { text: status.error, alert: true }
      : { text: status.active ? `已生效：${shortcutLabel(status.active)}` : "快捷键已关闭，可以点托盘图标打开便签。", alert: false };

  return (
    <section className="ns-section" aria-label="快捷键">
      <h2 className="ns-heading">快捷键</h2>
      <div className="ns-row">
        <label htmlFor="ns-key" className="ns-label">
          呼出 / 隐藏
        </label>
        <input
          id="ns-key"
          className="field pad-shortcut ns-grow"
          readOnly
          value={capturing ? "请按下新的组合键…" : shortcutLabel(shortcut)}
          disabled={busy}
          data-testid="ns-shortcut"
          onFocus={() => {
            setCapturing(true);
            setInvalid(false);
          }}
          onBlur={() => setCapturing(false)}
          onKeyDown={onKey}
        />
        <button type="button" className="btn-ghost small" disabled={busy || shortcut === DEFAULT_SCRATCHPAD_SHORTCUT} onClick={() => onSave(DEFAULT_SCRATCHPAD_SHORTCUT)}>
          恢复默认
        </button>
        <button type="button" className="btn-ghost small" disabled={busy || !shortcut} onClick={() => onSave("")}>
          关闭
        </button>
      </div>
      <p className={line.alert ? "form-error" : "ns-hint"} role={line.alert ? "alert" : "status"} data-testid="ns-shortcut-status">
        点一下输入框再按新的组合键。{line.text}
      </p>
    </section>
  );
}

function PagesSection({ link }: { link: HostLink }) {
  const pad = useScratchpad(link);
  const count = pad.doc?.pages.length ?? 0;
  const kept = pad.doc?.keptPages ?? [];
  return (
    <section className="ns-section" aria-label="页数">
      <h2 className="ns-heading">页数</h2>
      <div className="ns-row">
        <span className="pad-count">
          <button type="button" className="pad-step" aria-label="减少一页" disabled={!pad.doc || count <= 1} onClick={() => pad.setPageCount(count - 1)}>
            −
          </button>
          <span className="pad-count-value" data-testid="ns-page-count">
            {pad.doc ? count : "…"}
          </span>
          <button type="button" className="pad-step" aria-label="增加一页" disabled={!pad.doc || count >= SCRATCHPAD_MAX_PAGES} onClick={() => pad.setPageCount(count + 1)}>
            +
          </button>
        </span>
        <span className="ns-hint">最多 {SCRATCHPAD_MAX_PAGES} 页，便签里用 Alt+1…9 切换。减少页数不会删掉内容。</span>
      </div>
      {kept.length > 0 && <p className="ns-hint">第 {kept.join("、")} 页还有内容，现在藏着。</p>}
    </section>
  );
}

function MoveDialog({ from, to, busy, error, onCancel, onConfirm }: { from: string; to: string; busy: boolean; error: string | null; onCancel(): void; onConfirm(move: boolean): void }) {
  const [move, setMove] = useState(true);
  return (
    <div className="ns-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="ns-dialog" role="dialog" aria-label="更换工作文件夹" data-testid="ns-move">
        <header className="pad-head">
          <span className="pad-name">更换工作文件夹</span>
          <span className="spacer" />
          <button type="button" className="pad-icon" aria-label="取消" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="pad-rule" aria-hidden="true" />
        <div className="ns-dialog-body">
          <div className="ns-fromto">
            <span className="ns-hint">从</span>
            <span className="ns-path plain">{from}</span>
            <span className="ns-hint">到</span>
            <span className="ns-path plain">{to}</span>
          </div>
          <fieldset className="ns-choices">
            <legend>现有内容怎么办</legend>
            <label>
              <input type="radio" name="ns-move" checked={move} onChange={() => setMove(true)} />
              <span>
                迁移过去（推荐）
                <span className="ns-hint">复制到新文件夹再切换；旧文件夹里的留着，你可以自己删。</span>
              </span>
            </label>
            <label>
              <input type="radio" name="ns-move" checked={!move} onChange={() => setMove(false)} data-testid="ns-move-none" />
              <span>
                不迁移
                <span className="ns-hint">新文件夹已有便签就用它的，没有就从空白开始。</span>
              </span>
            </label>
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="pad-rule" aria-hidden="true" />
        <footer className="pad-foot ns-dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn-ghost small" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-primary small" disabled={busy} onClick={() => onConfirm(move)} data-testid="ns-move-confirm">
            {move ? "迁移并切换" : "切换"}
          </button>
        </footer>
      </div>
    </div>
  );
}
