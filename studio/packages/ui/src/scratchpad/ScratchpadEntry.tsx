import { useState } from "react";
import type { HostLink } from "../host/client.js";
import { scratchpadBridge } from "./bridge.js";
import { previewText } from "./logic.js";
import { PadImages, PadImageViewer } from "./PadImages.js";
import { SAVE_LABELS, useScratchpad } from "./useScratchpad.js";

/**
 * The scratchpad's entry at the bottom of the task page's right column: the page the window shows, in short, and
 * 打开便签. Without the app's window (a plain browser) the page is edited right here instead, as stage 2's draft area was.
 */
export function ScratchpadEntry({ link }: { link: HostLink }) {
  const pad = useScratchpad(link);
  const bridge = scratchpadBridge();
  const [viewing, setViewing] = useState<string | null>(null);
  const active = pad.doc?.activePage ?? 0;
  const text = pad.textOf(active);
  const images = pad.doc?.pages[active]?.attachments ?? [];
  const status = pad.state === "error" ? (pad.error ?? SAVE_LABELS.error) : SAVE_LABELS[pad.state];
  const open = () => void bridge?.open();

  return (
    <section className="scratchpad" aria-label="便签">
      <div className="anno-head">
        <span className="anno-title">便签</span>
        <span className="anno-count" data-testid="scratchpad-page">
          {pad.doc ? `第 ${active + 1} / ${pad.doc.pages.length} 页` : ""}
        </span>
        <span className="spacer" />
        {bridge && (
          <button type="button" className="link-btn primary" onClick={open}>
            打开便签
          </button>
        )}
      </div>
      {bridge ? (
        <button type="button" className="pad-preview" onClick={open} title="在便签窗口里编辑" data-testid="scratchpad-preview">
          {text.trim() ? previewText(text) : <span className="pad-preview-empty">这一页还是空的。</span>}
        </button>
      ) : (
        <>
          <textarea
            value={text}
            aria-label="便签内容"
            placeholder="随手记点什么，所有任务共用。"
            rows={6}
            onChange={(e) => pad.setText(active, e.target.value)}
          />
          {status && (
            <span className="anno-count" data-testid="scratchpad-status">
              {status}
            </span>
          )}
        </>
      )}
      <PadImages link={link} ids={images} onOpen={setViewing} />
      {viewing && <PadImageViewer link={link} id={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}
