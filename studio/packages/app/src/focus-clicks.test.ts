import { describe, expect, it } from "vitest";
import { EatenClicks, type Point } from "./focus-clicks.js";

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
