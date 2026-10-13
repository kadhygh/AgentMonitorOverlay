import { useEffect } from "react";
import type { HostLink } from "../host/client.js";
import { attachmentUrl } from "../lib/attachments.js";

/** A page's images as a strip of thumbnails under the text; click one for the large view, × takes it off the page. */
export function PadImages({ link, ids, onOpen, onRemove }: { link: HostLink; ids: readonly string[]; onOpen(id: string): void; onRemove?(id: string): void }) {
  if (!ids.length) return null;
  return (
    <div className="pad-images" data-testid="pad-images">
      {ids.map((id, i) => (
        <div key={id} className="pad-thumb" data-testid="pad-image">
          <button type="button" className="pad-thumb-open" onClick={() => onOpen(id)} aria-label={`看大图 ${i + 1}`} title="看大图">
            <img src={attachmentUrl(link, id)} alt={`图片 ${i + 1}`} draggable={false} />
          </button>
          {onRemove && (
            <button type="button" className="pad-thumb-remove" onClick={() => onRemove(id)} aria-label={`移除图片 ${i + 1}`} title="从这一页移除">
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The large view of one image; a click anywhere or Esc closes it. */
export function PadImageViewer({ link, id, onClose }: { link: HostLink; id: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the picture, not the window or dialog behind it.
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="pad-viewer" role="dialog" aria-label="大图" data-testid="pad-viewer" onClick={onClose}>
      <img src={attachmentUrl(link, id)} alt="大图" />
    </div>
  );
}
