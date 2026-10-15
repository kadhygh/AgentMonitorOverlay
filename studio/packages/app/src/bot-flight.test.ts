import { describe, expect, it } from "vitest";
import { fly, takeOff } from "./bot-flight.js";

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
});
