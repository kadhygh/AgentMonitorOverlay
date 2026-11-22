import { useCallback, useEffect, useState, type ReactNode } from "react";

// The frame of layout A「IM 三栏」(2026-11-23, plans/cowork.md 第 8 条, prototype studio/out/relay-redesign/a-im.html):
// the icon rail on the far left (待处理 · 协作 · 聊天 · 传文件 · 成员; 说明 · 设置 · me at its foot) → the view's list →
// the main area → the 信息栏 on the right that folds away (a session's; later a 协作's). Up to 1100 px wide (the default
// window is 1080, and 960) it starts folded, as in the prototype; opened there it sits beside the main area, and under
// 1024 px over it. A 协作's 子会话 and 白板 do not take that place: they open as floating windows over the page
// (Floats.tsx; the user, 2026-11-23, plans/cowork.md 第 9 条). The parts here know nothing of sessions or chats, so 协作
// (step 3) builds on them as they are.

/** Where the right panel starts folded (the prototype: under 1100 px the 信息栏 is folded until asked for). */
export const NARROW_QUERY = "(max-width: 1100px)";

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

/**
 * Whether a right panel is open. Wide, the choice is kept (localStorage, per `key`); narrow, it starts folded each time
 * and opening it there is not remembered — what was chosen on a wide window comes back when it is wide again.
 */
export function useSidePanel(key: string, defaultOpen = true): { open: boolean; setOpen: (v: boolean) => void; narrow: boolean } {
  const narrow = useMedia(NARROW_QUERY);
  const storeKey = `amo-relay.side.${key}`;
  const [pref, setPref] = useState(() => {
    try {
      const v = localStorage.getItem(storeKey);
      return v === null ? defaultOpen : v !== "0";
    } catch {
      return defaultOpen;
    }
  });
  const [narrowOpen, setNarrowOpen] = useState(false);
  useEffect(() => setNarrowOpen(false), [narrow]);
  const setOpen = useCallback(
    (v: boolean) => {
      if (narrow) return setNarrowOpen(v);
      setPref(v);
      try {
        localStorage.setItem(storeKey, v ? "1" : "0");
      } catch {
        // storage blocked: this window keeps it
      }
    },
    [narrow, storeKey],
  );
  return { open: narrow ? narrowOpen : pref, setOpen, narrow };
}

// ---- the icon rail

export function Rail({ children, foot }: { children: ReactNode; foot: ReactNode }) {
  return (
    <nav className="rail" aria-label="页面">
      {children}
      <span className="rail-sep" />
      {foot}
    </nav>
  );
}

export function RailItem(props: { label: string; icon: ReactNode; current?: boolean; badge?: number; title?: string; onClick: () => void }) {
  return (
    <button type="button" className="rail-item" aria-current={props.current ? "page" : undefined} title={props.title ?? props.label} onClick={props.onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {props.icon}
      </svg>
      <span className="rail-label">{props.label}</span>
      {!!props.badge && <span className="badge">{props.badge}</span>}
    </button>
  );
}

/** The rail's line drawings (the prototype's), one per page; no decoration beyond telling them apart. */
export const ICONS = {
  queue: (
    <>
      <path d="M4 13h4l2 3h4l2-3h4" />
      <path d="M5 13l2-7h10l2 7v5H5z" />
    </>
  ),
  cowork: (
    <>
      <circle cx="8" cy="9" r="3" />
      <circle cx="16" cy="9" r="3" />
      <path d="M3 19c0-3 2.5-5 5-5s5 2 5 5" />
      <path d="M11 19c0-3 2.5-5 5-5s5 2 5 5" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  transfers: (
    <>
      <path d="M7 4v13" />
      <path d="M3 13l4 4 4-4" />
      <path d="M17 20V7" />
      <path d="M13 11l4-4 4 4" />
    </>
  ),
  people: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" />
    </>
  ),
  tasks: (
    <>
      <path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7" />
      <path d="M12 17h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};

// ---- the list column

export function ListPane(props: { title: string; actions?: ReactNode; search?: { value: string; onChange: (v: string) => void; placeholder: string }; children: ReactNode; foot?: ReactNode; label?: string }) {
  return (
    <aside className="list-pane" aria-label={props.label ?? props.title}>
      <div className="list-head">
        <h2>{props.title}</h2>
        {props.actions}
      </div>
      {props.search && <input className="list-search" type="search" value={props.search.value} onChange={(e) => props.search!.onChange(e.target.value)} placeholder={props.search.placeholder} aria-label={props.search.placeholder} />}
      <div className="list-body">{props.children}</div>
      {props.foot && <div className="list-foot">{props.foot}</div>}
    </aside>
  );
}

/** A section label in a list: 「群聊 · 2」 with a rule after it. */
export function ListSection({ title, count }: { title: string; count?: number }) {
  return (
    <div className="list-sec">
      {title}
      {count != null && <span className="count"> · {count}</span>}
    </div>
  );
}

/**
 * A row of a list (a chat, a person, later a 协作): picture, title with its time, a line under it, an unread count.
 * `extra` sits over the row's right end on hover (归档 and the like).
 */
export function ListRow(props: { avatar?: ReactNode; title: ReactNode; time?: ReactNode; sub?: ReactNode; badge?: number; badgeQuiet?: boolean; dot?: "on" | "off"; current?: boolean; unread?: boolean; className?: string; label?: string; onClick: () => void; extra?: ReactNode }) {
  return (
    <div className={`list-row-wrap ${props.className ?? ""}`}>
      <button type="button" className={`list-row ${props.unread ? "unread" : ""}`} aria-current={props.current ? "true" : undefined} aria-label={props.label} onClick={props.onClick}>
        {props.avatar && <span className="list-row-av">{props.avatar}</span>}
        <span className="list-row-text">
          <span className="list-row-top">
            <span className="list-row-title">{props.title}</span>
            {props.time != null && <span className="list-row-time">{props.time}</span>}
          </span>
          {(props.sub != null || !!props.badge || props.dot) && (
            <span className="list-row-sub">
              <span className="list-row-subtext">{props.sub}</span>
              {!!props.badge && <span className={`badge ${props.badgeQuiet ? "quiet" : ""}`}>{props.badge}</span>}
              {props.dot && <span className={`dot ${props.dot === "on" ? "on" : ""}`} title={props.dot === "on" ? "在线" : "不在线"} />}
            </span>
          )}
        </span>
      </button>
      {props.extra && <span className="list-row-extra">{props.extra}</span>}
    </div>
  );
}

/** A filter row (全部 / 收到的 / 等你确认…): a name and a count. */
export function FilterRow({ label, count, current, hot, onClick }: { label: ReactNode; count?: number; current: boolean; hot?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="filter-row" aria-current={current ? "true" : undefined} onClick={onClick}>
      <span className="name">{label}</span>
      {count != null && <span className={`count ${hot && count ? "hot" : ""}`}>{count}</span>}
    </button>
  );
}

// ---- the right panel: the 信息栏

export function SidePanel(props: { title: ReactNode; sub?: ReactNode; onClose: () => void; closeLabel?: string; children: ReactNode; label: string; className?: string }) {
  return (
    <aside className={`side-panel ${props.className ?? ""}`} aria-label={props.label}>
      <div className="side-head">
        <div className="side-titles">
          <h3>{props.title}</h3>
          {props.sub && <div className="side-sub">{props.sub}</div>}
        </div>
        <button type="button" className="small ghost" onClick={props.onClose} title={`收起${props.label}`} aria-label={`收起${props.label}`}>
          {props.closeLabel ?? "收起 ›"}
        </button>
      </div>
      <div className="side-body">{props.children}</div>
    </aside>
  );
}

/** A block of the right panel: a small label (with a count and an action), then its content. */
export function SideBlock({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="side-blk" aria-label={title}>
      <h4>
        {title}
        {count != null && <span className="n">{count}</span>}
        {action && <span className="side-blk-act">{action}</span>}
      </h4>
      {children}
    </section>
  );
}
