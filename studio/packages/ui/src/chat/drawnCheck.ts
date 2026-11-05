// 问题 #17 again (2026-11-05, s-055401cc): after a message sent while the session was idle, the conversation area stayed
// blank until the next reply came or the session was opened again — no crash, no stall in logs/resize-trace.log, so
// nothing said what was on screen. Turns before the last three skip drawing off screen (chat.css, content-visibility);
// this looks at the conversation a moment after a send: a turn in view still skipped, or no turn in view at all, is
// written to the trace with where the scroller stood, and a skipped one is drawn (data-drawn) so it does not stay blank.

/** When after a send to look (ms): once things have laid out, and once the reply has had time to start. */
const CHECKS_MS = [1500, 4000];

export function checkDrawnAfterSend(scroller: HTMLElement, sessionId: string | undefined): void {
  for (const ms of CHECKS_MS) setTimeout(() => scroller.isConnected && check(scroller, sessionId, ms), ms);
}

function check(scroller: HTMLElement, sessionId: string | undefined, ms: number): void {
  if (document.visibilityState !== "visible") return;
  const box = scroller.getBoundingClientRect();
  if (box.height < 40) return;
  const turns = [...scroller.querySelectorAll<HTMLElement>("[data-testid=turn]")];
  const inView = turns.flatMap((el, index) => {
    const r = el.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom ? [{ el, index }] : [];
  });
  // checkVisibility on the turn's first child: false while the turn (its ancestor) skips its contents.
  const skipped = inView.filter(({ el }) => (el.firstElementChild as HTMLElement | null)?.checkVisibility?.({ contentVisibilityAuto: true }) === false);
  if (!turns.length || (inView.length && !skipped.length)) return;
  for (const { el } of skipped) el.dataset.drawn = "";
  window.amo?.trace?.({
    where: "#main blank after send",
    session: sessionId ?? null,
    ms,
    scroll: { top: Math.round(scroller.scrollTop), height: scroller.scrollHeight, client: scroller.clientHeight },
    turns: turns.length,
    inView: inView.map(({ el, index }) => ({ index, recent: el.hasAttribute("data-recent"), top: Math.round(el.getBoundingClientRect().top - box.top), height: Math.round(el.getBoundingClientRect().height) })),
    skipped: skipped.map(({ index }) => index),
  });
}
