import { useEffect, useRef, useState } from "react";

// 正在启动 (2026-10-23): starting a session waits for the model's process (a few seconds, more the first time); the part
// of the page it starts in is covered meanwhile, so nothing there is clicked or typed twice. The rest of the window
// stays usable. The cover blocks at once but only shows after a moment, so a quick start does not flash.

const SHOW_AFTER_MS = 200;
const SLOW_AFTER_MS = 15_000;

/** Covers its positioned parent while a session starts; `label` says what (正在启动 Claude…). */
export function StartingCover({ label }: { label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    // Keys go to the cover, not to the box under it that was being typed in.
    const parent = el.current?.parentElement;
    if (parent && document.activeElement instanceof HTMLElement && parent.contains(document.activeElement)) el.current?.focus();
    const show = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    const late = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(late);
    };
  }, []);
  return (
    <div ref={el} className={`starting-cover${shown ? " shown" : ""}`} tabIndex={-1} role="status" aria-live="polite" aria-busy="true" data-testid="starting-cover">
      {shown && (
        <div className="starting-box">
          <span className="starting-spin" aria-hidden="true" />
          <span className="starting-label">{label}</span>
          {slow && <span className="starting-slow">启动得比平时慢，可能在登录或准备环境，请稍候…</span>}
        </div>
      )}
    </div>
  );
}
