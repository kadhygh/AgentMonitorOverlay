// Resize trace, page side (2026-10-15): while the window is being resized, count the frames the page drew, the gaps
// between them, and Chromium's "long animation frames" with what ran in them and how long style and layout took.
// One summary per drag goes to the main process (logs/resize-trace.log). Between drags only frames of 200 ms or more
// are logged (a few per line).

interface LoafScript {
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: LoafScript[];
}

const IDLE_MS = 600;
/** A frame this long outside a drag is logged on its own. */
const STALL_MS = 200;

/** The longest frames, with what ran in them. */
function summarise(entries: readonly LoafEntry[]) {
  const file = (url?: string) => (url ? url.split("/").pop()!.split("?")[0] : "");
  return [...entries]
    .sort((x, y) => y.duration - x.duration)
    .slice(0, 6)
    .map((e) => ({
      ms: Math.round(e.duration),
      blocking: Math.round(e.blockingDuration ?? 0),
      // From the start of style and layout to the end of the frame.
      layout: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null,
      scripts: (e.scripts ?? [])
        .sort((x, y) => y.duration - x.duration)
        .slice(0, 3)
        .map((s) => `${s.invoker ?? "?"} ${file(s.sourceURL)}${s.sourceFunctionName ? `:${s.sourceFunctionName}` : ""} ${Math.round(s.duration)}ms${s.forcedStyleAndLayoutDuration ? ` forcedLayout ${Math.round(s.forcedStyleAndLayoutDuration)}ms` : ""}`),
    }));
}

/**
 * The Focus window's clicks as its page sees them (2026-10-15: its buttons ignored real clicks), to match against the
 * mouse messages the main process logs for it.
 */
export function traceFocusInput(): void {
  const send = window.amo?.trace;
  if (!send) return;
  const describe = (t: EventTarget | null) => {
    const el = t instanceof Element ? t : null;
    if (!el) return "?";
    const hit = el.closest("button, [role=button], a") ?? el;
    const label = hit.getAttribute("aria-label") ?? hit.getAttribute("data-testid") ?? (hit.textContent ?? "").trim().slice(0, 20);
    return `${hit.tagName.toLowerCase()}${typeof hit.className === "string" && hit.className ? `.${hit.className.split(" ")[0]}` : ""} ${label}`.trim();
  };
  for (const type of ["pointerdown", "click", "contextmenu"] as const) {
    document.addEventListener(type, (e) => send({ where: "#focus input", type, x: Math.round(e.clientX), y: Math.round(e.clientY), target: describe(e.target) }), true);
  }
}

export function startResizeTrace(): void {
  const send = window.amo?.trace;
  if (!send) return;
  let burst: {
    t0: number;
    last: number;
    events: number;
    frames: number;
    lastFrame: number;
    maxFrameGap: number;
    slowFrames: number;
    from: string;
    loaf: LoafEntry[];
    longtasks: number;
    timer: number;
    /** The size at the previous resize event, and sudden shrinks (2026-10-15: the page once saw the minimum size, 960×600, mid-drag). */
    prev: [number, number];
    drops: string[];
  } | null = null;

  const size = () => `${window.innerWidth}×${window.innerHeight}`;
  const frame = (t: number) => {
    if (!burst) return;
    if (burst.lastFrame) {
      const gap = t - burst.lastFrame;
      burst.maxFrameGap = Math.max(burst.maxFrameGap, gap);
      if (gap > 50) burst.slowFrames++;
    }
    burst.lastFrame = t;
    burst.frames++;
    requestAnimationFrame(frame);
  };

  // Between drags (2026-10-15, a flicker when a conversation started): frames that took 200 ms or more, a few at a
  // time, at most one line every 2 seconds.
  let stalls: LoafEntry[] = [];
  let stallTimer = 0;
  const flushStalls = () => {
    stallTimer = 0;
    const list = stalls;
    stalls = [];
    if (list.length) send({ where: where(), stalls: list.length, worst: summarise(list) });
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (burst) {
          if (e.entryType === "long-animation-frame") burst.loaf.push(e as LoafEntry);
          else if (e.entryType === "longtask") burst.longtasks++;
        } else if (e.duration >= STALL_MS) {
          stalls.push(e as LoafEntry);
          if (!stallTimer) stallTimer = window.setTimeout(flushStalls, 2000);
        }
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    // older Chromium: long tasks only
  }
  try {
    new PerformanceObserver((list) => {
      if (burst) burst.longtasks += list.getEntries().length;
    }).observe({ type: "longtask", buffered: false });
  } catch {
    // not supported
  }

  // The window (by its hash) and what the main area shows: its first labelled region, else its first element's class.
  const where = () => {
    const main = document.querySelector("main.main");
    const labelled = main?.querySelector("[aria-label]")?.getAttribute("aria-label");
    const first = main?.firstElementChild?.className;
    return [location.hash.split("?")[0] || "#main", labelled ?? (typeof first === "string" ? first : "")].filter(Boolean).join(" ");
  };

  const flush = () => {
    const b = burst;
    burst = null;
    if (!b) return;
    const loaf = summarise(b.loaf);
    send({
      where: where(),
      ms: Math.round(b.last - b.t0),
      size: `${b.from} → ${size()}`,
      resizeEvents: b.events,
      frames: b.frames,
      fps: b.last > b.t0 ? Math.round((b.frames * 1000) / (b.last - b.t0 + IDLE_MS)) : null,
      maxFrameGap: Math.round(b.maxFrameGap),
      slowFrames: b.slowFrames,
      longAnimationFrames: b.loaf.length,
      longtasks: b.longtasks,
      worst: loaf,
      dom: document.getElementsByTagName("*").length,
      theme: document.documentElement.dataset.theme ?? "system",
      dpr: window.devicePixelRatio,
      drops: b.drops,
    });
  };

  window.addEventListener("resize", () => {
    const now = performance.now();
    if (!burst) {
      burst = { t0: now, last: now, events: 0, frames: 0, lastFrame: 0, maxFrameGap: 0, slowFrames: 0, from: size(), loaf: [], longtasks: 0, timer: 0, prev: [window.innerWidth, window.innerHeight], drops: [] };
      requestAnimationFrame(frame);
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    if ((burst.prev[0] - w > 100 || burst.prev[1] - h > 100) && burst.drops.length < 10) burst.drops.push(`+${Math.round(now - burst.t0)}ms ${burst.prev[0]}×${burst.prev[1]}→${w}×${h}`);
    burst.prev = [w, h];
    burst.events++;
    burst.last = now;
    clearTimeout(burst.timer);
    burst.timer = window.setTimeout(flush, IDLE_MS);
  });
}
