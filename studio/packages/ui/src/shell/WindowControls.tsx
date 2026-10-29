import { useEffect, useState, type ReactNode } from "react";
import { inAmo } from "../lib/where.js";

// The windows have no system title bar (the workbench since stage 9; 书签, the 画布小窗, Git Review and the viewer since
// 2026-10-29, the user: all in AMO's style): a row of the page is the title bar — it drags the window (`.titlebar`,
// shell.css), its buttons and fields stay clickable — and ends with these buttons. In a plain browser (no
// window.amo.windowControls) there is nothing to draw: the browser has its own.

/** The page draws the window's title bar (Electron with the window buttons). */
export function ownTitleBar(): boolean {
  return !!window.amo?.windowControls;
}

/** The program's mark at the left of a title bar: AMO Studio's, or the AMO Reviewer's when it runs alone. */
export function appMark(): string {
  return inAmo() ? "./icon.svg" : "./reviewer.svg";
}

/** The mark at the start of a title bar (nothing in a plain browser, where the page has no title bar). */
export function TitleMark() {
  if (!ownTitleBar()) return null;
  return <img className="titlebar-mark" src={appMark()} alt="" aria-hidden="true" />;
}

/**
 * Minimise, maximise / restore and close, in the page's own style. `maximize={false}`: a small window (the 画布小窗) has
 * no maximise button. `closeTitle`: what × does, when it is not just closing the window (the workbench hides).
 */
export function WindowControls({ maximize = true, closeTitle = "关闭" }: { maximize?: boolean; closeTitle?: string }) {
  const api = window.amo?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api || !maximize) return;
    void api.isMaximized().then(setMaximized);
    return api.onMaximized(setMaximized);
  }, [api, maximize]);
  if (!api) return null;
  return (
    <div className="win-controls" role="group" aria-label="窗口" data-testid="win-controls">
      <button type="button" className="win-btn" aria-label="最小化" title="最小化" onClick={api.minimize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 5.5 H9.5" />
        </svg>
      </button>
      {maximize && (
        <button type="button" className="win-btn" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={api.toggleMaximize}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            {maximized ? <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5 M0.5 2.5 H7.5 V9.5 H0.5 Z" /> : <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" />}
          </svg>
        </button>
      )}
      <button type="button" className="win-btn close" aria-label="关闭" title={closeTitle} onClick={api.close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </button>
    </div>
  );
}

/**
 * A narrow title bar of its own, for a window whose page has no head yet (正在连接、读取中、出错): the window's name and
 * its buttons, so it can still be moved and closed. Nothing in a plain browser.
 */
export function TitleBar({ title, maximize = true, children }: { title: string; maximize?: boolean; children?: ReactNode }) {
  if (!ownTitleBar()) return null;
  return (
    <header className="titlebar win-titlebar" data-testid="win-titlebar">
      <TitleMark />
      <span className="titlebar-name">{title}</span>
      {children}
      <span className="spacer" />
      <WindowControls maximize={maximize} />
    </header>
  );
}

/** A window's placeholder (正在连接 Host…, 项目不存在…) under its narrow title bar. */
export function WindowPlaceholder({ title, maximize = true, children, testId }: { title: string; maximize?: boolean; children: ReactNode; testId?: string }) {
  return (
    <div className="win-placeholder">
      <TitleBar title={title} maximize={maximize} />
      <div className="placeholder" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}
