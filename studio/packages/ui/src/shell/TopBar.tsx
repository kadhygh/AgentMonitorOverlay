import { useEffect, useState } from "react";
import type { Scope } from "../board/Board.js";
import { scratchpadBridge } from "../scratchpad/bridge.js";
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

/**
 * The top bar, which is also the window's title bar: brand and scope, what needs the person, the scratchpad and Focus
 * windows, and the window buttons. The views' tabs and "+ 新任务" sit in the row below (ViewBar).
 */
export function TopBar({ onView, needs, scopeName, focus }: { onView(view: View): void; focus: { on: boolean; available: boolean; set(on: boolean): void }; needs: number; scopeName: string }) {
  const scratchpad = scratchpadBridge();
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
      <div className="spacer" />
      {needs > 0 && (
        <button type="button" className="needs" onClick={() => onView({ kind: "board" })} data-testid="needs-you">
          <span className="dot" style={{ background: "var(--attention)", width: 7, height: 7 }} />
          需要你 {needs}
        </button>
      )}
      {scratchpad && (
        <button type="button" className="tb-btn" title="打开便签小窗（也可以用设置 → 便签里的全局快捷键）" onClick={() => void scratchpad.open()} data-testid="open-scratchpad">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 2.5h10a.5.5 0 0 1 .5.5v6.3L9.3 13.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
            <path d="M13.5 9.3H10a.7.7 0 0 0-.7.7v3.5M5 5.5h6M5 8h3.5" />
          </svg>
          便签
        </button>
      )}
      {focus.available && (
        <button
          type="button"
          className="tb-btn focus-toggle"
          aria-pressed={focus.on}
          title={focus.on ? "Focus 已开：桌面角落的悬浮窗，只列需要你处理的会话。点击关闭" : "打开 Focus：桌面角落的悬浮窗，只列需要你处理的会话"}
          onClick={() => focus.set(!focus.on)}
          data-testid="focus-toggle"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="10" rx="1.5" />
            <rect className="fill" x="8.3" y="4.3" width="4.4" height="3.4" rx="0.7" />
            <path d="M5.5 14.5h5" />
          </svg>
          Focus
          <span className="focus-state" aria-hidden="true" />
        </button>
      )}
      <WindowControls />
    </header>
  );
}

/** The row under the title bar: the views' tabs on the left, "+ 新任务" on the right. */
export function ViewBar({
  views,
  view,
  scope,
  onView,
  onNew,
  disabled = false,
}: {
  views: readonly AnyViewDef[];
  view: View | null;
  scope: Scope;
  onView(view: View): void;
  onNew(): void;
  disabled?: boolean;
}) {
  return (
    <div className="viewbar">
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
      <button type="button" className="btn-primary" onClick={onNew} disabled={disabled} title="新建任务（Ctrl N 在任何页面打开快速启动条）">
        + 新任务
      </button>
    </div>
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
