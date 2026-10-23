import { useEffect, useRef, useState } from "react";
import { call, copyText, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { imagesOf } from "../lib/attachments.js";
import { scratchpadBridge } from "./bridge.js";
import { clipboardText, pageFromKey, shortcutLabel } from "./logic.js";
import { inNotesProgram, notesCall } from "../notes/api.js";
import { PadImages, PadImageViewer } from "./PadImages.js";
import { SAVE_LABELS, useScratchpad } from "./useScratchpad.js";

// The scratchpad window (loaded with #scratchpad; after old AMO's ScratchpadApp): numbered pages, Ctrl+1…9 to switch,
// text that saves as you type, pasted or dropped images under it. Esc or × hides the window; 复制 (or Ctrl+Enter)
// copies the page (line breaks as the settings say) and hides it, as old AMO did. The page count is in the settings.
// 2026-10-23 (the 便签 program): one tone, short rules under the head and over the foot, the keys written by what they
// do, an empty page listing them, and a one-time notice after the pages came over from Studio.

/** The scratchpad's mark, as on the title bar's 便签 button. */
export function ScratchpadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="pad-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.5h10a.5.5 0 0 1 .5.5v6.3L9.3 13.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M13.5 9.3H10a.7.7 0 0 0-.7.7v3.5M5 5.5h6M5 8h3.5" />
    </svg>
  );
}

/** The window's name, with its mark. */
function PadName() {
  return (
    <span className="pad-name">
      <ScratchpadIcon />
      便签
    </span>
  );
}

export function ScratchpadApp() {
  const host = useHostState();
  if (host.kind !== "ready") {
    return (
      <div className="pad-root">
        <header className="pad-head">
          <PadName />
        </header>
        <div className="pad-empty">{host.kind === "connecting" ? "正在连接 Host…" : host.reason}</div>
      </div>
    );
  }
  return <ScratchpadWindow link={host.link} />;
}

function ScratchpadWindow({ link }: { link: HostLink }) {
  const pad = useScratchpad(link);
  const bridge = scratchpadBridge();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The show / hide shortcut as bound now, for the empty page's list (it follows the settings).
  const [shortcut, setShortcut] = useState<string | null>(null);
  // The 便签 program after the pages came over from Studio: said once, until closed.
  const [imported, setImported] = useState(false);
  const notes = inNotesProgram();
  const { doc } = pad;
  const active = doc?.activePage ?? 0;

  // Switching pages puts the caret in the page, like old AMO.
  useEffect(() => {
    const t = setTimeout(() => area.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    const read = () =>
      void call(link, "GET /api/settings")
        .then((s) => setShortcut(s.scratchpadShortcut))
        .catch(() => undefined);
    read();
    // Changed in the settings while this window stays open: read again when it comes back.
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [link]);

  useEffect(() => {
    if (!notes) return;
    void notesCall(link, "GET", "")
      .then((info) => setImported(!!info.settings.importedAt && !info.settings.importNoticeSeen))
      .catch(() => undefined);
  }, [link, notes]);

  const padRef = useRef(pad);
  padRef.current = pad;
  const copyRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        scratchpadBridge()?.hide();
        return;
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void copyRef.current();
        return;
      }
      const page = pageFromKey(e, padRef.current.doc?.pages.length ?? 0);
      if (page !== null) {
        e.preventDefault();
        padRef.current.setActive(page);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!doc) {
    return (
      <div className="pad-root">
        <header className="pad-head">
          <PadName />
        </header>
        <div className="pad-empty">正在读取…</div>
      </div>
    );
  }

  const text = pad.textOf(active);
  const images = doc.pages[active]?.attachments ?? [];

  function paste(data: DataTransfer | null, event: { preventDefault(): void }) {
    const files = imagesOf(data);
    if (!files.length) return;
    event.preventDefault();
    void pad.addImages(active, files);
  }

  async function copy() {
    if (!/\S/.test(text)) {
      setNote("这一页是空的");
      area.current?.focus();
      return;
    }
    // The setting as it is now (it may have changed in 设置 since this window opened); lines kept if it cannot be read.
    const safe = await call(link, "GET /api/settings")
      .then((s) => s.scratchpadSafeNewlines)
      .catch(() => false);
    await copyText(clipboardText(text, safe));
    setNote(safe ? "已复制（安全换行）" : "已复制");
    bridge?.hide();
  }
  copyRef.current = copy;

  function clear() {
    const el = area.current;
    if (!el) return;
    // Through the editor, so Ctrl+Z brings it back.
    el.focus();
    el.select();
    if (!document.execCommand("delete")) pad.setText(active, "");
    setNote("已清空，Ctrl+Z 可以撤销");
  }

  const empty = !text && !images.length;
  const status = pad.state === "error" ? (pad.error ?? SAVE_LABELS.error) : (note ?? SAVE_LABELS[pad.state]);
  const kept = doc.keptPages.length ? `第 ${doc.keptPages.join("、")} 页还有内容，在${notes ? "便签设置" : "设置 → 便签"}里增加页数就能看到` : "";
  const hotkey = shortcut ? shortcutLabel(shortcut).split(" + ").join(" ") : "";
  const closeImported = () => {
    setImported(false);
    void notesCall(link, "PATCH", "/settings", { importNoticeSeen: true }).catch(() => undefined);
  };

  return (
    <div
      className="pad-root"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        // Never let a dropped file open in the window; images join the page, anything else is ignored.
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
        paste(e.dataTransfer, e);
      }}
    >
      <header className="pad-head">
        <PadName />
        <nav className="pad-pages" aria-label="便签页">
          {doc.pages.map((p, i) => (
            <button
              key={i}
              type="button"
              className="pad-page"
              aria-pressed={i === active}
              aria-label={`第 ${i + 1} 页`}
              title={`第 ${i + 1} 页（Ctrl+${i + 1}）`}
              data-filled={p.text.trim() || p.attachments.length ? "" : undefined}
              data-testid="pad-page"
              onClick={() => (i === active ? area.current?.focus() : pad.setActive(i))}
            >
              {i + 1}
            </button>
          ))}
        </nav>
        <span className="pad-hint">Ctrl 1–{doc.pages.length}</span>
        <span className="spacer" />
        {bridge && (
          <button type="button" className="pad-icon pad-hide" aria-label="隐藏便签" title="隐藏（Esc）" onClick={() => bridge.hide()}>
            <kbd className="pad-key">Esc</kbd>×
          </button>
        )}
      </header>
      <div className="pad-rule" aria-hidden="true" />
      {imported && (
        <div className="pad-notice" role="status" data-testid="pad-imported">
          <span>已从 AMO Studio 搬过来原来的便签内容和图片，Studio 里的旧数据还留着。</span>
          <button type="button" className="pad-icon" aria-label="知道了" title="知道了" onClick={closeImported}>
            ×
          </button>
        </div>
      )}
      <div className="pad-body">
        <textarea
          ref={area}
          className="pad-text"
          aria-label="便签内容"
          spellCheck={false}
          placeholder="随手记下要回复的要点。"
          value={text}
          onChange={(e) => {
            setNote(null);
            pad.setText(active, e.target.value);
          }}
          onPaste={(e) => paste(e.clipboardData, e)}
        />
        {empty && (
          <ul className="pad-keys" aria-label="按键" data-testid="pad-keys">
            <li>
              <kbd className="pad-key">Ctrl V</kbd>粘贴或拖入图片，跟这一页放在一起
            </li>
            <li>
              <kbd className="pad-key">Ctrl ↵</kbd>复制这一页并隐藏
            </li>
            <li>
              <kbd className="pad-key">Ctrl 1–{doc.pages.length}</kbd>换页
            </li>
            <li>
              <kbd className="pad-key">Esc</kbd>隐藏{hotkey ? `；${hotkey} 随时叫回来` : ""}
            </li>
          </ul>
        )}
      </div>
      <PadImages link={link} ids={images} onOpen={setViewing} onRemove={(id) => pad.removeImage(active, id)} />
      <div className="pad-rule" aria-hidden="true" />
      <footer className="pad-foot">
        <span className="pad-status" data-testid="pad-status" title={kept || status}>
          {empty ? "空白页" : `${text.length} 字`}
          {status ? ` · ${status}` : ""}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={clear} disabled={empty}>
          清空
        </button>
        <button type="button" className="btn-primary small pad-copy" aria-label="复制" onClick={() => void copy()} disabled={empty} title="复制这一页并隐藏（Ctrl+Enter）">
          复制<kbd className="pad-key">Ctrl ↵</kbd>
        </button>
      </footer>
      {viewing && <PadImageViewer link={link} id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
