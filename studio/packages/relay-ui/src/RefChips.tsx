import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { copyText, shell } from "./env.js";
import { copiedText, parseRef, type Ref } from "./refs.js";

// 复制引用 and the jumps (2026-11-23, the user: 可以，按你的建议做 / 反向跳转也一起做): a message's `cowork:` `thread:`
// `studio:` refs shown as chips (Markdown.tsx), the right-click menu that copies them, and 在 Studio 里打开 for my own
// AIs (refs.ts has the words).

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- the chips

/** What a chip shows for a ref and what a click does; Home gives it (it knows the lists and opens things). */
export interface RefsCtx {
  /** The chip's words, its hover text, and whether a click opens it (false: one I cannot see). */
  describe(ref: Exclude<Ref, { kind: "studio" }>, label: string | null): { text: string; hint: string; can: boolean };
  open(ref: Exclude<Ref, { kind: "studio" }>): void;
  /** This computer (the shell's device), when known. */
  device: string | null;
  toast(text: string): void;
}
export const RefsContext = createContext<RefsCtx | null>(null);

export function RefChip({ refAt, raw, label }: { refAt: Ref; raw: string; label: string | null }) {
  const ctx = useContext(RefsContext);
  if (refAt.kind === "studio") return <StudioChip mark={raw} device={refAt.device} label={label} />;
  if (!ctx)
    return (
      <span className="ref-chip off" data-ref={raw}>
        {label ? `「${label}」` : raw}
      </span>
    );
  const d = ctx.describe(refAt, label);
  return d.can ? (
    <button type="button" className={`ref-chip kind-${refAt.kind}`} data-ref={raw} title={d.hint} onClick={() => ctx.open(refAt)}>
      {d.text}
    </button>
  ) : (
    <span className="ref-chip off" data-ref={raw} title={d.hint}>
      {d.text}
    </span>
  );
}

/** studioHas, asked once in a while per mark (a list of messages may name the same session many times). */
const hasCache = new Map<string, { at: number; v: Promise<boolean> }>();
function studioHasNow(mark: string): Promise<boolean> {
  const hit = hasCache.get(mark);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const v = shell?.studioHas ? shell.studioHas(mark).catch(() => false) : Promise.resolve(false);
  hasCache.set(mark, { at: Date.now(), v });
  return v;
}

/**
 * A Studio session (`studio:<设备号>:<会话>`): a click shows it in this computer's Studio when the device is this one's and
 * Studio runs with it (shell.studioHas); otherwise a plain chip saying why not.
 */
function StudioChip({ mark, device, label }: { mark: string; device: string; label: string | null }) {
  const ctx = useContext(RefsContext);
  const here = ctx?.device ? ctx.device === device : null;
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (here === false || !shell?.studioHas) return;
    let alive = true;
    void studioHasNow(mark).then((v) => alive && setHas(v));
    return () => void (alive = false);
  }, [mark, here]);
  const text = label ? `Studio 会话「${label}」` : "Studio 会话";
  const why = !shell ? "在桌面客户端里才能跳到 Studio" : !shell.openInStudio ? "这个中转客户端还不能跳到 Studio：更新中转客户端后再试" : here === false ? "在另一台电脑上" : has === false ? (here ? "Studio 没开着" : "在另一台电脑上，或者这台电脑的 Studio 没开着") : null;
  if (why || has !== true)
    return (
      <span className="ref-chip off kind-studio" data-ref={mark} title={why ?? "看这台电脑的 Studio 开着没有…"}>
        {text}
      </span>
    );
  return (
    <button type="button" className="ref-chip kind-studio" data-ref={mark} title="在这台电脑的 Studio 里打开" onClick={() => ctx && void openStudio(mark, ctx.toast)}>
      {text}
    </button>
  );
}

// ---- 在 Studio 里打开

/** Asks the shell to show it in Studio; a toast says how it went. */
export async function openStudio(mark: string, toast: (t: string) => void): Promise<void> {
  if (!shell?.openInStudio) return toast("这个中转客户端还不能跳到 Studio：更新中转客户端后再试");
  const why = await shell.openInStudio(mark).catch((err: unknown) => errorText(err));
  toast(why ? `没能在 Studio 里打开：${why}` : "已在 Studio 里打开这个会话");
}

/**
 * Where my AI's session is, for 在 Studio 里打开: "here" (a button), "elsewhere" (「在另一台电脑上」, no button), null —
 * someone else's AI, not a Studio one, or no shell to ask (nothing shown). With the device unknown (an older shell) it
 * counts as here: the click then says why not.
 */
export function studioWhere(mark: string | null | undefined, owner: string, me: string, device: string | null): "here" | "elsewhere" | null {
  if (!mark || owner !== me || !shell?.openInStudio) return null;
  const r = parseRef(mark);
  if (r?.kind !== "studio") return null;
  return device && r.device !== device ? "elsewhere" : "here";
}

// ---- the right-click menu

/** An item, or null: a line between items (one at either end or next to another is left out — an item not offered can be null). */
export type MenuItem = { label: ReactNode; onClick: () => void; disabled?: boolean; hint?: string } | null;
let menu: { x: number; y: number; items: MenuItem[] } | null = null;
const menuListeners = new Set<() => void>();
const setMenu = (m: typeof menu) => {
  menu = m;
  for (const l of menuListeners) l();
};

/** Opens the menu at the pointer (a right click, or a click on a name). Nothing to show: the browser's own stays away too. */
export function openMenu(e: ReactMouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  const shown = items.filter((it, i) => it || (i > 0 && items[i - 1] && items.slice(i + 1).some(Boolean)));
  if (shown.length) setMenu({ x: e.clientX, y: e.clientY, items: shown });
}

/** The one menu of the page (Home puts it there). */
export function MenuHost() {
  const m = useSyncExternalStore(
    (l) => (menuListeners.add(l), () => menuListeners.delete(l)),
    () => menu,
  );
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!m || !box.current) return setAt(null);
    // Kept inside the window.
    const r = box.current.getBoundingClientRect();
    setAt({ x: Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4)) });
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const close = () => setMenu(null);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [m]);
  if (!m) return null;
  return (
    <div ref={box} className="menu ctx-menu" role="menu" style={{ left: at?.x ?? m.x, top: at?.y ?? m.y, visibility: at ? "visible" : "hidden" }}>
      {m.items.map((it, i) =>
        it ? (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              setMenu(null);
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ) : (
          <div key={i} className="menu-sep" />
        ),
      )}
    </div>
  );
}

/** 复制引用: copies it and the toast says what. */
export const copyRef = (text: string, what: string, toast: (t: string) => void) =>
  void copyText(text).then(
    () => toast(copiedText(what)),
    (err: unknown) => toast(errorText(err)),
  );
