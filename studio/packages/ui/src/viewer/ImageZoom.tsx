import { useEffect, useRef } from "react";
import { ImageView } from "./ImageView.js";

// 看大图 (2026-11-06): a picture of a rendered HTML or Markdown file shown enlarged over the page, instead of the viewer
// opening it in place of the page (the user clicked a screenshot in a report and could not get back). Esc, a click
// beside it or × closes it. 2026-11-11: the picture itself is the viewer's ImageView (fitted, wheel and buttons zoom,
// drag once larger, right-click 另存为…), as a picture file is shown.

export type ZoomedImage = {
  /** What the <img> loads. */
  url: string;
  /** Its name, shown at the top. */
  name: string;
  /** The file it is, when there is one: 在查看器中打开 / 在资源管理器中显示 act on it. */
  open?: () => void;
  reveal?: () => void;
};

export function ImageZoom({ image, onClose }: { image: ZoomedImage; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);

  // The keys reach this window only: the page's frame gave the focus away when it asked for the picture.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(".iv")?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A menu open over the picture (右键) takes Esc first.
      if (e.key !== "Escape" || document.querySelector(".ctx-menu")) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="iz" ref={box} role="dialog" aria-label={`看大图：${image.name}`} onClick={(e) => e.target === e.currentTarget && onClose()} data-testid="image-zoom">
      <div className="iz-bar">
        <span className="iz-name" title={image.name}>
          {image.name}
        </span>
        {image.open && (
          <button type="button" className="btn-ghost small" onClick={image.open} data-testid="image-zoom-open">
            在查看器中打开
          </button>
        )}
        {image.reveal && (
          <button type="button" className="btn-ghost small" onClick={image.reveal} data-testid="image-zoom-reveal">
            在资源管理器中显示
          </button>
        )}
        <button type="button" className="btn-ghost small iz-x" aria-label="关闭" title="关闭（Esc）" onClick={onClose} data-testid="image-zoom-close">
          ×
        </button>
      </div>
      <ImageView key={image.url} url={image.url} name={image.name} className="iz-view" margin={24} imgTestId="image-zoom-img" onBackgroundClick={onClose} />
      <div className="iz-hint">Esc 或点旁边关闭 · 滚轮缩放 · 放大后拖动 · 右键另存为</div>
    </div>
  );
}
