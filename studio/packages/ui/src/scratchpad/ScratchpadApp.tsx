import { useEffect, useRef, useState } from "react";
import { SCRATCHPAD_MAX_PAGES } from "@amo-studio/protocol";
import { copyText, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { imagesOf } from "../lib/attachments.js";
import { scratchpadBridge } from "./bridge.js";
import { pageFromKey } from "./logic.js";
import { PadImages, PadImageViewer } from "./PadImages.js";
import { SAVE_LABELS, useScratchpad } from "./useScratchpad.js";

// The scratchpad window (loaded with #scratchpad; after old AMO's ScratchpadApp): numbered pages, Ctrl+1…9 to switch,
// text that saves as you type, pasted or dropped images under it. Esc or × hides the window; 复制 copies the page and
// hides it, as old AMO did.

export function ScratchpadApp() {
  const host = useHostState();
  if (host.kind !== "ready") {
    return (
      <div className="pad-root">
        <header className="pad-head">
          <span className="pad-name">便签</span>
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
  const { doc } = pad;
  const active = doc?.activePage ?? 0;
  const count = doc?.pages.length ?? 0;

  // Switching pages puts the caret in the page, like old AMO.
  useEffect(() => {
    const t = setTimeout(() => area.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [active]);

  const padRef = useRef(pad);
  padRef.current = pad;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        scratchpadBridge()?.hide();
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
          <span className="pad-name">便签</span>
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
    await copyText(text);
    setNote("已复制");
    bridge?.hide();
  }

  function clear() {
    const el = area.current;
    if (!el) return;
    // Through the editor, so Ctrl+Z brings it back.
    el.focus();
    el.select();
    if (!document.execCommand("delete")) pad.setText(active, "");
    setNote("已清空，Ctrl+Z 可以撤销");
  }

  const status = pad.state === "error" ? (pad.error ?? SAVE_LABELS.error) : (note ?? SAVE_LABELS[pad.state]);
  const kept = doc.keptPages.length ? `第 ${doc.keptPages.join("、")} 页还有内容，增加页数就能看到` : "";

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
        <span className="pad-name">便签</span>
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
        <span className="spacer" />
        {bridge && (
          <button type="button" className="pad-icon" aria-label="隐藏便签" title="隐藏（Esc）" onClick={() => bridge.hide()}>
            ×
          </button>
        )}
      </header>
      <textarea
        ref={area}
        className="pad-text"
        aria-label="便签内容"
        spellCheck={false}
        placeholder="随手记下要回复的要点。可以直接粘贴或拖入图片。"
        value={text}
        onChange={(e) => {
          setNote(null);
          pad.setText(active, e.target.value);
        }}
        onPaste={(e) => paste(e.clipboardData, e)}
      />
      <PadImages link={link} ids={images} onOpen={setViewing} onRemove={(id) => pad.removeImage(active, id)} />
      <footer className="pad-foot">
        <span className="pad-status" data-testid="pad-status" title={kept || status}>
          {text.length} 字{status ? ` · ${status}` : ""}
        </span>
        <span className="spacer" />
        <span className="pad-count" title={kept || "页数（减少页数不会删掉内容）"}>
          页数
          <button type="button" className="pad-step" aria-label="减少页数" disabled={count <= 1} onClick={() => pad.setPageCount(count - 1)}>
            −
          </button>
          <span data-testid="pad-page-count">{count}</span>
          <button type="button" className="pad-step" aria-label="增加页数" disabled={count >= SCRATCHPAD_MAX_PAGES} onClick={() => pad.setPageCount(count + 1)}>
            +
          </button>
        </span>
        <button type="button" className="btn-ghost small" onClick={clear}>
          清空
        </button>
        <button type="button" className="btn-primary small" onClick={() => void copy()}>
          复制
        </button>
      </footer>
      {viewing && <PadImageViewer link={link} id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
