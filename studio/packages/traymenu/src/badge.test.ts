import { describe, expect, it } from "vitest";
import { badgeText, countBadge, iconWithBadge } from "./badge.js";

const at = (px: Uint8Array, size: number, x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
/** The white pixels (the digits): their bounding box. */
function digits(px: Uint8Array, size: number): { x0: number; y0: number; x1: number; y1: number; n: number } {
  const box = { x0: size, y0: size, x1: -1, y1: -1, n: 0 };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (at(px, size, x, y).every((v) => v === 255)) {
        box.n++;
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x);
        box.y1 = Math.max(box.y1, y);
      }
  return box;
}

describe("the count badge (2026-10-29)", () => {
  it("says nothing for none, the number up to 99, then 99+", () => {
    expect([0, -1, Number.NaN, 1, 7, 99, 100, 1234].map(badgeText)).toEqual(["", "", "", "1", "7", "99", "99+", "99+"]);
  });

  it("an empty image for none", () => {
    expect(countBadge(16, 0).every((v) => v === 0)).toBe(true);
  });

  it("the overlay: a red disc with white digits inside it, at every size Windows asks for", () => {
    for (const size of [16, 20, 24, 32])
      for (const count of [1, 12, 100]) {
        const px = countBadge(size, count);
        const c = Math.floor(size / 2);
        // Corners clear (round), the edge column in the middle red.
        expect(at(px, size, 0, 0)[3]).toBe(0);
        expect(at(px, size, size - 1, size - 1)[3]).toBe(0);
        const d = digits(px, size);
        expect(d.n).toBeGreaterThan(4);
        // Inside the disc, with room around it, roughly centred.
        expect(d.x0).toBeGreaterThan(0);
        expect(d.x1).toBeLessThan(size - 1);
        expect(Math.abs((d.x0 + d.x1) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs((d.y0 + d.y1) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(1);
        // Red somewhere off the digits: in the middle row, near the edge.
        const [b, g, r, a] = at(px, size, 1, c);
        expect(a).toBe(255);
        expect(r).toBeGreaterThan(150);
        expect(Math.max(b!, g!)).toBeLessThan(80);
      }
  });

  it("on an icon: the badge at the bottom right, the icon's top left untouched, a gap cut around the badge", () => {
    const size = 16;
    const icon = new Uint8Array(size * size * 4).fill(200);
    const px = iconWithBadge(icon, size, 3);
    expect(at(px, size, 0, 0)).toEqual([200, 200, 200, 200]);
    expect(icon[0]).toBe(200); // the icon itself is left as it was
    const d = digits(px, size);
    expect(d.x0).toBeGreaterThanOrEqual(8);
    expect(d.y0).toBeGreaterThanOrEqual(8);
    // The gap: just left of the badge, in its middle row, the icon is cleared.
    const h = Math.round(size * 0.625);
    const row = size - Math.ceil(h / 2);
    let cleared = false;
    for (let x = 0; x < d.x0; x++) if (at(px, size, x, row)[3]! < 100) cleared = true;
    expect(cleared).toBe(true);
    // 99+ still fits (as wide as the icon at most).
    const wide = digits(iconWithBadge(icon, size, 120), size);
    expect(wide.x0).toBeGreaterThanOrEqual(0);
    expect(wide.x1).toBeLessThan(size);
  });
});
