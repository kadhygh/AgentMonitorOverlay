import { useCallback, useEffect, useState, type RefObject } from "react";

// Jumps between agent replies of the open session: "上一条 / 下一条" buttons and Alt+↑ / Alt+↓.
// The current reply is the last one whose top edge has scrolled to (or above) the top of the thread.

const EDGE = 12;

function replies(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>("[data-item-type='agent']")];
}

function currentIndex(scroller: HTMLElement, list: HTMLElement[]): number {
  const box = scroller.getBoundingClientRect();
  const top = box.top + EDGE + 1;
  let index = -1;
  list.forEach((el, i) => {
    if (el.getBoundingClientRect().top <= top) index = i;
  });
  // Above the first reply (e.g. its question is showing): the first reply counts as current once it is visible.
  if (index < 0 && list[0] && list[0].getBoundingClientRect().top < box.bottom) index = 0;
  // At the bottom the last reply may never reach the top edge; once it is visible it is the current one.
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const last = list.at(-1);
  if (atBottom && last && last.getBoundingClientRect().top < box.bottom) index = list.length - 1;
  return index;
}

export function flash(el: HTMLElement): void {
  el.classList.remove("md-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("md-flash");
  setTimeout(() => el.classList.remove("md-flash"), 1600);
}

export function ReplyNav({ scroller, itemCount }: { scroller: RefObject<HTMLDivElement | null>; itemCount: number }) {
  const [position, setPosition] = useState({ index: -1, total: 0 });

  const refresh = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const list = replies(el);
    setPosition({ index: currentIndex(el, list), total: list.length });
  }, [scroller]);

  const jump = useCallback(
    (delta: 1 | -1) => {
      const el = scroller.current;
      if (!el) return;
      const list = replies(el);
      if (!list.length) return;
      const now = currentIndex(el, list);
      // Going up from inside a long reply first returns to that reply's own top.
      const nowTop = now >= 0 ? list[now]!.getBoundingClientRect().top - el.getBoundingClientRect().top : 0;
      let target = delta > 0 ? now + 1 : nowTop < -EDGE ? now : now - 1;
      target = Math.max(0, Math.min(list.length - 1, target));
      const node = list[target]!;
      el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - EDGE;
      flash(node);
      refresh();
    },
    [scroller, refresh],
  );

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    refresh();
    el.addEventListener("scroll", refresh, { passive: true });
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      jump(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", refresh);
      window.removeEventListener("keydown", onKey);
    };
  }, [scroller, refresh, jump]);

  useEffect(refresh, [itemCount, refresh]);

  if (position.total < 2) return null;
  return (
    <div className="reply-nav" role="navigation" aria-label="回复跳转">
      <button type="button" aria-label="上一条回复" title="上一条回复（Alt+↑）" onClick={() => jump(-1)}>
        ↑
      </button>
      <span className="reply-pos" data-testid="reply-position">
        {position.index + 1} / {position.total}
      </span>
      <button type="button" aria-label="下一条回复" title="下一条回复（Alt+↓）" onClick={() => jump(1)}>
        ↓
      </button>
    </div>
  );
}
