import { describe, expect, it } from "vitest";
import { PAD_SIZE, placePad } from "./placement.js";

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const right = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 680 }, scaleFactor: 1.5 };

describe("placePad (moved from Studio with the 便签, 2026-10-23)", () => {
  it("opens beside the pointer the first time, flipping away from the display's edges", () => {
    expect(placePad(null, { x: 100, y: 100 }, [primary])).toEqual({ x: 112, y: 112, ...PAD_SIZE });
    expect(placePad(null, { x: 1900, y: 1000 }, [primary])).toEqual({ x: 1900 - 480 - 12, y: 1000 - 320 - 12, ...PAD_SIZE });
    // On the second display, inside its own work area.
    const p = placePad(null, { x: 3150, y: 20 }, [primary, right]);
    expect(p.x).toBeGreaterThanOrEqual(1920);
    expect(p.x + p.width).toBeLessThanOrEqual(3200);
  });

  it("keeps the remembered place and size, pulled back on screen", () => {
    const saved = { x: 300, y: 200, width: 600, height: 400 };
    expect(placePad(saved, { x: 0, y: 0 }, [primary])).toEqual(saved);
    expect(placePad({ ...saved, x: 1700 }, { x: 0, y: 0 }, [primary])).toEqual({ ...saved, x: 1920 - 600 });
    // Its display is gone: back beside the pointer, at the remembered size.
    expect(placePad({ ...saved, x: 2500 }, { x: 100, y: 100 }, [primary])).toEqual({ x: 112, y: 112, width: 600, height: 400 });
  });
});
