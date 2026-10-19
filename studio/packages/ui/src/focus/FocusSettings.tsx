import type { ReactNode } from "react";

// 「Focus 设置」 and Focus's icons (stage 16 split out of FocusApp.tsx).

export interface SettingItem {
  label: string;
  icon: ReactNode;
  onPick(): void;
  /** A switch (stays open, shows its state); otherwise an action. */
  checked?: boolean;
  /** Close the box after the action. */
  close?: boolean;
  disabled?: boolean;
  hint?: string | undefined;
  testId: string;
}

/** 「Focus 设置」: a small box above the panel with ×. Switches stay open; actions close it. */
export function FocusSettings({ items, onClose }: { items: SettingItem[]; onClose(): void }) {
  return (
    <div className="focus-pop" role="dialog" aria-label="Focus 设置" onContextMenu={(e) => e.preventDefault()} data-testid="focus-menu">
      <div className="focus-pop-head">
        <span className="focus-pop-title">Focus 设置</span>
        <button type="button" className="focus-pop-x" aria-label="关闭" title="关闭" onClick={onClose} data-testid="focus-menu-close">
          {ICON.x}
        </button>
      </div>
      {items.map((it) => (
        <button
          key={it.testId}
          type="button"
          className="focus-pop-row"
          role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={it.checked}
          disabled={it.disabled}
          title={it.hint}
          onClick={() => {
            if (it.close) onClose();
            it.onPick();
          }}
          data-testid={it.testId}
        >
          <span className="focus-menu-icon">{it.icon}</span>
          <span className="focus-menu-label">
            {it.label}
            {it.checked !== undefined && it.hint && <span className="focus-pop-hint">{it.hint}</span>}
          </span>
          {it.checked !== undefined && <span className={it.checked ? "focus-switch on" : "focus-switch"} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

const svg = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

/** 16px stroke icons, as in the rest of Studio. */
export const ICON = {
  // The panel grows up from its bottom edge: up opens the list, down folds it to one line.
  expand: svg(<path d="M4 10l4-4 4 4" />),
  collapse: svg(<path d="M4 6l4 4 4-4" />),
  move: svg(<path d="M8 1.8v12.4M1.8 8h12.4M6.3 3.5 8 1.8l1.7 1.7M6.3 12.5 8 14.2l1.7-1.7M3.5 6.3 1.8 8l1.7 1.7M12.5 6.3 14.2 8l-1.7 1.7" />),
  lock: svg(
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ),
  window: svg(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <path d="M2 6h12" />
    </>,
  ),
  // A window with arrows pulling it to the middle.
  center: svg(
    <>
      <rect x="5" y="5.5" width="6" height="5" rx="0.8" />
      <path d="M1.5 8h2M12.5 8h2M8 1.5v2M8 12.5v2" />
    </>,
  ),
  gear: svg(
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>,
  ),
  // A pointer passing through a sheet.
  through: svg(
    <>
      <path d="M2.5 9.5h11" strokeDasharray="2 1.6" />
      <path d="M8 2v10.5M5.6 10.1 8 12.5l2.4-2.4" />
    </>,
  ),
  x: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  bot: svg(
    <>
      <rect x="3" y="4.5" width="10" height="7.5" rx="1.5" />
      <path d="M8 4.5V2.2M6 8h.01M10 8h.01M6.5 10.2h3M1.8 7.5v2.5M14.2 7.5v2.5" />
    </>,
  ),
  hide: svg(
    <>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <path d="M3 13 13 3" />
    </>,
  ),
};
