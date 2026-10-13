import { useEffect, useState } from "react";
import type { Scope } from "../board/Board.js";
import type { AnyViewDef, View } from "./views.js";

/** Focus window on/off, mirrored from the Electron shell (absent in a plain browser). */
export function useFocusToggle(): { on: boolean; available: boolean; set(on: boolean): void } {
  const api = window.amo?.focus;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.get().then(setOn);
    return api.onChange(setOn);
  }, [api]);
  return { on, available: !!api, set: (next) => void api?.set(next) };
}

/** The top bar, which is also the window's title bar: brand and scope, the views' tabs, what needs the person, actions. */
export function TopBar({
  views,
  view,
  scope,
  onView,
  onNew,
  onSettings,
  needs,
  scopeName,
  focus,
  disabled = false,
}: {
  views: readonly AnyViewDef[];
  view: View | null;
  scope: Scope;
  onView(view: View): void;
  focus: { on: boolean; available: boolean; set(on: boolean): void };
  onNew(): void;
  onSettings?: () => void;
  needs: number;
  scopeName: string;
  disabled?: boolean;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src="./icon.svg" alt="" aria-hidden="true" />
        <span className="brand-name">AMO Studio</span>
        {scopeName && (
          <>
            <span className="brand-sep">/</span>
            <span style={{ fontWeight: 500 }}>{scopeName}</span>
          </>
        )}
      </div>
      <nav className="view-tabs" aria-label="视图">
        {views.map((def) => {
          const target = def.tab?.open(scope);
          if (!def.tab || !target) return null;
          // A page opened from another one (a task from the canvas) keeps that one's tab current.
          const from = view && "back" in view ? view.back : undefined;
          const current = !!view && (view.kind === def.kind || (from ? from.kind === def.kind : !!def.tab.alsoFor?.includes(view.kind)));
          return (
            <button key={def.kind} type="button" className="view-tab" aria-current={current ? "page" : undefined} onClick={() => onView(target)} disabled={disabled}>
              {def.tab.label}
            </button>
          );
        })}
      </nav>
      <div className="spacer" />
      {needs > 0 && (
        <button type="button" className="needs" onClick={() => onView({ kind: "board" })} data-testid="needs-you">
          <span className="dot" style={{ background: "var(--attention)", width: 7, height: 7 }} />
          需要你 {needs}
        </button>
      )}
      {focus.available && (
        <button
          type="button"
          className="btn-ghost small"
          aria-pressed={focus.on}
          title="桌面角落的悬浮窗：只列需要你处理的会话"
          onClick={() => focus.set(!focus.on)}
        >
          Focus {focus.on ? "开" : "关"}
        </button>
      )}
      {onSettings && (
        <button type="button" className="btn-ghost small" onClick={onSettings} aria-label="设置" title="设置：界面主题、公共目录、模型">
          设置
        </button>
      )}
      <button type="button" className="btn-primary" onClick={onNew} disabled={disabled} title="新建任务（Ctrl N 在任何页面打开快速启动条）">
        + 新任务
      </button>
      <WindowControls />
    </header>
  );
}

/** Minimise, maximise / restore and close, drawn by the page in its own style (the window has no system title bar). */
function WindowControls() {
  const api = window.amo?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.isMaximized().then(setMaximized);
    return api.onMaximized(setMaximized);
  }, [api]);
  if (!api) return null;
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
      <button type="button" className="win-btn close" aria-label="关闭" title="关闭" onClick={api.close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </button>
    </div>
  );
}
