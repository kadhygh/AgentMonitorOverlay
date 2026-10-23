import { useLayoutEffect, type RefObject } from "react";

// A top bar that must stay on one line (2026-10-23: Review's buttons from 历史 to 刷新): the width it needs is its
// items that do not shrink (buttons, segmented groups) at their width, the ones that do (titles, paths) at their
// min-width, plus gaps and padding. The window is told (window.amo.setMinWidth) and is not made narrower than the
// widest bar on the page; each bar keeps its own entry while shown.

const needs = new Map<symbol, number>();
let sent = -1;

function report(): void {
  const px = Math.max(0, ...needs.values());
  if (px === sent) return;
  sent = px;
  window.amo?.setMinWidth?.(px);
}

/**
 * The window width `bar` needs to show every item that does not shrink: its items, plus what lies beside it (a 查看包's
 * list on its left); 0 while it is hidden.
 */
export function neededWidth(bar: HTMLElement): number {
  if (!bar.offsetParent && getComputedStyle(bar).position !== "fixed") return 0;
  const cs = getComputedStyle(bar);
  const box = bar.getBoundingClientRect();
  const beside = Math.max(0, box.left) + Math.max(0, document.documentElement.clientWidth - box.right);
  const kids = [...bar.children].filter((k): k is HTMLElement => k instanceof HTMLElement && getComputedStyle(k).display !== "none");
  let w = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  w += (parseFloat(cs.columnGap) || 0) * Math.max(0, kids.length - 1);
  for (const k of kids) {
    const ks = getComputedStyle(k);
    w += ks.flexShrink === "0" ? k.getBoundingClientRect().width : parseFloat(ks.minWidth) || 0;
  }
  return Math.ceil(w + beside);
}

/** Keeps the window at least as wide as `bar` needs, while it is shown. */
export function useFitWidth(bar: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !window.amo?.setMinWidth) return;
    const id = Symbol("bar");
    const measure = () => {
      needs.set(id, neededWidth(el));
      report();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const k of el.children) ro.observe(k);
    // Buttons coming and going (历史 once the branch is read, a commit's subject): measure again.
    const mo = new MutationObserver(() => {
      for (const k of el.children) ro.observe(k);
      measure();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
      needs.delete(id);
      report();
    };
  }, [bar]);
}
