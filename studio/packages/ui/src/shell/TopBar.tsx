import { useEffect, useState, type ReactNode } from "react";
import type { Scope } from "../board/Board.js";
import { scratchpadBridge } from "../scratchpad/bridge.js";
import { showToast } from "../lib/toast.js";
import type { AnyViewDef, View } from "./views.js";
import { RemoteIcon } from "./BackButton.js";
import { WindowControls } from "./WindowControls.js";

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

/** 置顶 (stage 14): the workbench window above other windows, mirrored from the Electron shell. */
export function usePinToggle(): { on: boolean; available: boolean; set(on: boolean): void } {
  const api = window.amo?.pin;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.get().then(setOn);
    return api.onChange(setOn);
  }, [api]);
  return { on, available: !!api, set: (next) => void api?.set(next) };
}

/**
 * The top bar, which is also the window's title bar: brand and scope, what needs the person, the marks, 远程 (its own
 * page), scratchpad and Focus windows, and the window buttons. The views' tabs and "+ 新任务" sit in the row below (ViewBar).
 */
export function TopBar({
  onView,
  onMarks,
  nav,
  needs,
  scopeName,
  focus,
  pin,
  mark = "./icon.svg",
  remote,
}: {
  /** 远程 (2026-10-29): the button that opens the remote page (remote/remote.ts remoteButton says what it shows). */
  remote?: { shown: boolean; label: string; waiting: boolean; current: boolean; open(): void };
  /** The top-left icon: 「AMO 娘」's while she is the 桌宠 (focus/mascot.ts), else the app's viewfinder. */
  mark?: string | undefined;
  /** 后退 / 前进 (2026-10-19). */
  nav?: { canBack: boolean; canForward: boolean; go(dir: -1 | 1): void };
  onView(view: View): void;
  focus: { on: boolean; available: boolean; set(on: boolean): void };
  /** 置顶 (stage 14). */
  pin?: { on: boolean; available: boolean; set(on: boolean): void };
  /** 书签 (文件标记 before 2026-10-19): the bookmarks window. */
  onMarks?: () => void;
  needs: number;
  scopeName: string;
}) {
  const scratchpad = scratchpadBridge();
  return (
    <header className="topbar">
      <div className="brand">
        <img className={mark.includes("/mascot/") ? "brand-mark mascot" : "brand-mark"} src={mark} alt="" aria-hidden="true" data-testid="brand-mark" />
        <span className="brand-name">AMO Studio</span>
        {scopeName && (
          <>
            <span className="brand-sep">/</span>
            <span style={{ fontWeight: 500 }}>{scopeName}</span>
          </>
        )}
      </div>
      {nav && (
        <div className="tb-nav" role="group" aria-label="后退和前进">
          <button type="button" className="tb-btn icon" disabled={!nav.canBack} onClick={() => nav.go(-1)} title="后退（Alt+←）" aria-label="后退" data-testid="nav-back">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="tb-btn icon" disabled={!nav.canForward} onClick={() => nav.go(1)} title="前进（Alt+→）" aria-label="前进" data-testid="nav-forward">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
      <div className="spacer" />
      {needs > 0 && (
        <button type="button" className="needs" onClick={() => onView({ kind: "board" })} data-testid="needs-you">
          <span className="dot" style={{ background: "var(--attention)", width: 7, height: 7 }} />
          需要你 {needs}
        </button>
      )}
      {onMarks && (
        <button type="button" className="tb-btn" onClick={onMarks} title="书签：按专题记下的文件和对话片段，可以拖进对话（Ctrl+Shift+M）" data-testid="topbar-marks">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10.6a.3.3 0 0 1-.48.24L8 11.2l-3.52 2.64A.3.3 0 0 1 4 13.6V3a.5.5 0 0 1 .5-.5Z" />
          </svg>
          书签
        </button>
      )}
      {remote?.shown && (
        <button
          type="button"
          className="tb-btn remote-toggle"
          aria-current={remote.current ? "page" : undefined}
          title={remote.waiting ? "远程：有配对请求、任务请求或对方的回复等你看" : "远程：你的其他设备、授权给它们的任务、在别的设备上跑的任务"}
          onClick={remote.open}
          data-testid="topbar-remote"
        >
          <RemoteIcon />
          {remote.label}
          {remote.waiting && <span className="settings-dot" aria-label="有请求或回复等你看" data-testid="topbar-remote-dot" />}
        </button>
      )}
      {scratchpad && (
        <button type="button" className="tb-btn" title="打开便签（它是单独的小程序，也可以用它的全局快捷键）" onClick={() => void scratchpad.open().catch((err: unknown) => showToast({ text: err instanceof Error ? err.message : String(err), error: true }))} data-testid="open-scratchpad">
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
      {pin?.available && (
        <button
          type="button"
          className="tb-btn focus-toggle pin-toggle"
          aria-pressed={pin.on}
          title={pin.on ? "置顶已开：工作台窗口一直浮在其他窗口上面。点击关闭" : "置顶：让工作台窗口一直浮在其他窗口上面"}
          onClick={() => pin.set(!pin.on)}
          data-testid="pin-toggle"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path className="fill" d="M6 2.5h4l-.6 4.2 2.1 2.3H4.5l2.1-2.3Z" />
            <path d="M6 2.5h4l-.6 4.2 2.1 2.3H4.5l2.1-2.3ZM8 9v4.5" />
          </svg>
          置顶
          <span className="focus-state" aria-hidden="true" />
        </button>
      )}
      {/* 2026-10-29: × only hides the window; Studio and the sessions go on in the tray (完全退出 is in the tray's menu). */}
      <WindowControls closeTitle="关闭窗口（Studio 留在托盘里，会话继续；完全退出在托盘图标的右键菜单里）" />
    </header>
  );
}

/** The row under the title bar: the views' tabs on the left, the search box (stage 14) and "+ 新任务" on the right. */
export function ViewBar({
  views,
  view,
  scope,
  onView,
  onNew,
  search,
  disabled = false,
}: {
  views: readonly AnyViewDef[];
  view: View | null;
  scope: Scope;
  onView(view: View): void;
  onNew(): void;
  /** 搜索 (stage 14), left of "+ 新任务". */
  search?: ReactNode;
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
      {search}
      <button type="button" className="btn-primary" onClick={onNew} disabled={disabled} title="新建任务（Ctrl N 在任何页面打开快速启动条）">
        + 新任务
      </button>
    </div>
  );
}
