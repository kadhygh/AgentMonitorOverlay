// Passage trace (2026-10-20, 书签 → 打开对话 did not reach the passage for the person, and no test run could make it
// fail): each step from the bookmarks window to the flashed passage, written by the shell to logs/passage-trace.log.

type TraceBridge = { passageTrace?(line: string): void };

/** One line of the trace; outside Electron, the console. */
export function passageTrace(what: string, detail?: unknown): void {
  const line = detail === undefined ? what : `${what} ${JSON.stringify(detail)}`;
  const bridge = window.amo as TraceBridge | undefined;
  if (bridge?.passageTrace) bridge.passageTrace(line);
  else console.debug("[passage]", line);
}

/** Where `el` sits in the scrolling view around it, and that view's scroll, for the trace. */
export function placeOf(el: Element | null): unknown {
  if (!el) return null;
  let s: HTMLElement | null = el.parentElement;
  while (s && !(["auto", "scroll"].includes(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement;
  const r = el.getBoundingClientRect();
  const v = s?.getBoundingClientRect();
  return {
    top: Math.round(r.top - (v?.top ?? 0)),
    bottom: Math.round(r.bottom - (v?.top ?? 0)),
    view: s ? { scrollTop: Math.round(s.scrollTop), scrollHeight: s.scrollHeight, height: s.clientHeight, cls: s.className } : null,
    hidden: document.hidden,
    winH: innerHeight,
  };
}
