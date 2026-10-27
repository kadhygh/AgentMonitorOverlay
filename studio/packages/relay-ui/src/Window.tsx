import { useEffect, useState } from "react";
import { shell } from "./env.js";

// The window's own buttons, as in AMO Studio (shell/TopBar.tsx): the desktop client has no system title bar, so the
// top bar is the title bar — it drags the window — and ends with minimise, maximise / restore and close (close hides
// it to the tray). A Mac keeps its traffic lights; a browser or an older client keeps the system's bar.

export const ownTitleBar = !!shell?.windowControls;
export const macLights = ownTitleBar && /mac|darwin/i.test(navigator.platform);

export function WindowControls() {
  const api = shell?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.isMaximized().then(setMaximized);
    api.onMaximized(setMaximized);
  }, [api]);
  if (!api || macLights) return null;
  return (
    <div className="win-controls" role="group" aria-label="窗口">
      <button type="button" className="win-btn" aria-label="最小化" title="最小化" onClick={api.minimize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 5.5 H9.5" />
        </svg>
      </button>
      <button type="button" className="win-btn" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={api.toggleMaximize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5 M0.5 2.5 H7.5 V9.5 H0.5 Z" /> : <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" />}
        </svg>
      </button>
      <button type="button" className="win-btn close" aria-label="关闭" title="关闭（留在托盘里）" onClick={api.close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </button>
    </div>
  );
}
