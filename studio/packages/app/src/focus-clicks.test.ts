import { describe, expect, it } from "vitest";
import { CaptionDrag, EatenClicks, type Point } from "./focus-clicks.js";

function setup() {
  let time = 0;
  const timers: Array<() => void> = [];
  const replayed: Point[] = [];
  const clicks = new EatenClicks({ replay: (p) => replayed.push(p), now: () => time, later: (fn) => void timers.push(fn), graceMs: 60, maxPressMs: 3000 });
  return {
    clicks,
    replayed,
    advance: (ms: number) => (time += ms),
    flush: () => timers.splice(0).forEach((fn) => fn()),
  };
}

describe("Focus clicks dropped by Chromium", () => {
  it("replays a press the page never saw, where it was pressed", () => {
    const t = setup();
    t.clicks.activated({ x: 60, y: 510 });
    t.advance(80);
    t.clicks.released();
    expect(t.replayed).toEqual([]);
    t.flush();
    expect(t.replayed).toEqual([{ x: 60, y: 510 }]);
  });

  it("leaves a click alone when the page saw its pointerdown, before or just after the release", () => {
    const t = setup();
    t.clicks.activated({ x: 1, y: 1 });
    t.clicks.pagePressed();
    t.clicks.released();
    t.flush();
    t.clicks.activated({ x: 2, y: 2 });
    t.clicks.released();
    t.clicks.pagePressed();
    t.flush();
    expect(t.replayed).toEqual([]);
  });

  it("does nothing for releases without an activation press, long presses, or a press that was not in the page", () => {
    const t = setup();
    t.clicks.released();
    t.clicks.activated({ x: 3, y: 3 });
    t.advance(5000);
    t.clicks.released();
    t.clicks.activated(null);
    t.clicks.released();
    t.flush();
    expect(t.replayed).toEqual([]);
  });

  it("replays each lost click once", () => {
    const t = setup();
    t.clicks.activated({ x: 4, y: 4 });
    t.clicks.released();
    t.clicks.released();
    t.flush();
    t.flush();
    expect(t.replayed).toEqual([{ x: 4, y: 4 }]);
  });
});

describe("Focus title-row drags", () => {
  function drag(alreadyAllowed = false) {
    const calls: boolean[] = [];
    const timers: Array<() => void> = [];
    let allowed = alreadyAllowed;
    const d = new CaptionDrag({
      allow: (on) => {
        calls.push(on);
        allowed = on;
      },
      allowed: () => allowed,
      later: (fn) => void timers.push(fn),
    });
    return { d, calls, flush: () => timers.splice(0).forEach((fn) => fn()) };
  }

  it("lets the window activate for the press and stops when the move ends", () => {
    const t = drag();
    expect(t.d.pressed()).toBe(true);
    t.d.entered();
    t.flush();
    expect(t.calls).toEqual([true]);
    t.d.exited();
    expect(t.calls).toEqual([true, false]);
    t.d.exited();
    expect(t.calls).toEqual([true, false]);
  });

  it("stops after a while when no move started", () => {
    const t = drag();
    t.d.pressed();
    t.flush();
    expect(t.calls).toEqual([true, false]);
    t.d.exited();
    expect(t.calls).toEqual([true, false]);
  });

  it("does nothing while 移动位置 already lets the window activate", () => {
    const t = drag(true);
    expect(t.d.pressed()).toBe(false);
    t.d.entered();
    t.d.exited();
    t.flush();
    expect(t.calls).toEqual([]);
  });

  it("a second press during a drag does not start another", () => {
    const t = drag();
    t.d.pressed();
    expect(t.d.pressed()).toBe(false);
    t.d.exited();
    expect(t.calls).toEqual([true, false]);
  });
});
