import { describe, expect, it } from "vitest";
import { canPan, clampLayout, fitLayout, MAX_SCALE, panBy, zoomAt } from "./imageFit.js";

const pane = { w: 1000, h: 600 };

describe("fitLayout", () => {
  it("shows an ordinary picture whole, centred", () => {
    expect(fitLayout(pane, { w: 2000, h: 1000 })).toEqual({ scale: 0.5, x: 0, y: 50 });
    expect(fitLayout(pane, { w: 900, h: 1800 })).toEqual({ scale: 1 / 3, x: 350, y: 0 });
  });

  it("never blows a small picture up", () => {
    expect(fitLayout(pane, { w: 100, h: 50 })).toEqual({ scale: 1, x: 450, y: 275 });
  });

  it("keeps a phone screenshot whole (not long enough to count as long)", () => {
    const v = fitLayout(pane, { w: 1080, h: 2400 });
    expect(v.scale).toBeCloseTo(0.25);
    expect(v.y).toBe(0);
    expect(v.x).toBeCloseTo((1000 - 270) / 2);
  });

  it("fits a long screenshot to the width, from its top", () => {
    const v = fitLayout(pane, { w: 1280, h: 6000 });
    expect(v.scale).toBeCloseTo(1000 / 1280);
    expect(v).toMatchObject({ x: 0, y: 0 });
    expect(canPan(pane, { w: 1280, h: 6000 }, v)).toBe(true);
  });

  it("fits a strip to the height, from its left", () => {
    const v = fitLayout(pane, { w: 9000, h: 1200 });
    expect(v.scale).toBeCloseTo(0.5);
    expect(v).toMatchObject({ x: 0, y: 0 });
  });

  it("shows a long picture that fits anyway at its own size, centred", () => {
    expect(fitLayout(pane, { w: 100, h: 400 })).toEqual({ scale: 1, x: 450, y: 100 });
  });
});

describe("zoomAt and panBy", () => {
  const natural = { w: 2000, h: 1000 };
  it("keeps the point under the pointer where it is", () => {
    const fit = fitLayout(pane, natural);
    const v = zoomAt(pane, natural, fit, 1, { x: 250, y: 300 });
    expect(v.scale).toBe(1);
    // The picture's point under (250, 300) was (500, 500) at 0.5; at 1 it is still under the pointer.
    expect(v.x).toBeCloseTo(-250);
    expect(v.y).toBeCloseTo(-200);
  });

  it("goes no further than its limits", () => {
    expect(zoomAt(pane, natural, fitLayout(pane, natural), 1000, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });

  it("drags as far as the picture's edges", () => {
    const at1 = clampLayout(pane, natural, { scale: 1, x: -500, y: -200 });
    expect(panBy(pane, natural, at1, 10_000, 10_000)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panBy(pane, natural, at1, -10_000, -10_000)).toEqual({ scale: 1, x: -1000, y: -400 });
    // Smaller than the pane: stays centred.
    expect(panBy(pane, natural, { scale: 0.25, x: 0, y: 0 }, 300, 300)).toEqual({ scale: 0.25, x: 250, y: 175 });
    expect(canPan(pane, natural, { scale: 0.25, x: 250, y: 175 })).toBe(false);
  });
});
