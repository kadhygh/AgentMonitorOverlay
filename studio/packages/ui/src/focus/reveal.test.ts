import { describe, expect, it } from "vitest";
import { revealDelta } from "./reveal.js";

// 展开后看全 (2026-11-06): how far the Focus list scrolls for a card that opened.
describe("revealing an opened card", () => {
  // A list showing 100..500.
  it("leaves a card that shows whole", () => {
    expect(revealDelta(100, 500, 150, 400, 8)).toBe(0);
  });
  it("scrolls down until its bottom is in", () => {
    expect(revealDelta(100, 500, 300, 620, 8)).toBe(128);
  });
  it("taller than the list: its top stays in view", () => {
    expect(revealDelta(100, 500, 300, 900, 8)).toBe(192);
  });
  it("above the list: scrolls up to its top", () => {
    expect(revealDelta(100, 500, 40, 300, 8)).toBe(-68);
  });
});
