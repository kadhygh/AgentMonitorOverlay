import { describe, expect, it } from "vitest";
import { fly, HOLD_AFTER_MS, holding, pointerOn, takeOff } from "./bot-flight.js";

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 240, height: 120 };
/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

describe("the angry robot's flight", () => {
  it("takes off inside the work area, moving", () => {
    const f = takeOff({ x: 5000, y: -40 }, size, area, seeded(1));
    expect(f.x).toBe(1680);
    expect(f.y).toBe(0);
    expect(Math.hypot(f.vx, f.vy)).toBeGreaterThan(300);
  });

  it("stays inside the work area and keeps moving for a long flight, wandering all over it", () => {
    const random = seeded(7);
    let f = takeOff({ x: 1600, y: 900 }, size, area, random);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 120; i++) {
      const before = f;
      f = fly(f, 1 / 60, size, area, random);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x).toBeLessThanOrEqual(1680);
      expect(f.y).toBeLessThanOrEqual(920);
      expect(f.x !== before.x || f.y !== before.y).toBe(true);
      seen.add(`${Math.floor(f.x / 480)},${Math.floor(f.y / 260)}`);
    }
    // Every part of a 4×4 grid of the screen was visited in two minutes.
    expect(seen.size).toBe(16);
  });

  it("bounces off an edge", () => {
    const f = fly({ x: 1670, y: 500, vx: 600, vy: 0, turnIn: 5 }, 0.1, size, area);
    expect(f.x).toBe(1680);
    expect(f.vx).toBe(-600);
  });

  it("stops while the pointer is on it, and flies on a moment after it left (追到了就停)", () => {
    // The robot (its bubble beside it) in a window at 1000,400.
    const shape = [
      { x: 10, y: 40, width: 90, height: 100 },
      { x: 110, y: 50, width: 200, height: 40 },
    ];
    const at = { x: 1000, y: 400 };
    expect(pointerOn({ x: 1050, y: 480 }, at, shape)).toBe(true);
    expect(pointerOn({ x: 1200, y: 460 }, at, shape)).toBe(true);
    // In the window but on neither (the transparent rest), and outside it.
    expect(pointerOn({ x: 1005, y: 405 }, at, shape)).toBe(false);
    expect(pointerOn({ x: 900, y: 480 }, at, shape)).toBe(false);
    expect(holding(true, null, 10_000)).toBe(true);
    expect(holding(false, 10_000, 10_000 + HOLD_AFTER_MS - 1)).toBe(true);
    expect(holding(false, 10_000, 10_000 + HOLD_AFTER_MS)).toBe(false);
    expect(holding(false, null, 10_000)).toBe(false);
  });
});
