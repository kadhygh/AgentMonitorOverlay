import { useState } from "react";
import type { HostLink } from "../host/client.js";
import { PadImages, PadImageViewer } from "./PadImages.js";
import { SAVE_LABELS, useScratchpad } from "./useScratchpad.js";

/**
 * The scratchpad edited inside 设置 → 便签, for a plain browser only: there the app's scratchpad window does not exist
 * (S14-B: the task page no longer shows the scratchpad).
 */
export function ScratchpadEntry({ link }: { link: HostLink }) {
  const pad = useScratchpad(link);
  const [viewing, setViewing] = useState<string | null>(null);
  const active = pad.doc?.activePage ?? 0;
  const text = pad.textOf(active);
  const images = pad.doc?.pages[active]?.attachments ?? [];
  const status = pad.state === "error" ? (pad.error ?? SAVE_LABELS.error) : SAVE_LABELS[pad.state];

  return (
    <section className="settings-section scratchpad" aria-label="便签内容">
      <span className="settings-heading">便签内容</span>
      <span className="settings-hint" data-testid="scratchpad-page">
        {pad.doc ? `第 ${active + 1} / ${pad.doc.pages.length} 页。浏览器里没有便签小窗，在这里编辑。` : "正在读取…"}
      </span>
      <textarea value={text} aria-label="便签内容" placeholder="随手记点什么，所有任务共用。" rows={6} onChange={(e) => pad.setText(active, e.target.value)} />
      {status && (
        <span className="settings-hint" data-testid="scratchpad-status">
          {status}
        </span>
      )}
      <PadImages link={link} ids={images} onOpen={setViewing} />
      {viewing && <PadImageViewer link={link} id={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}
