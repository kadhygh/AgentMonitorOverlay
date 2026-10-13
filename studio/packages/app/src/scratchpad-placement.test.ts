import { describe, expect, it } from "vitest";
import { placeScratchpad, SCRATCHPAD_SIZE } from "./scratchpad-placement.js";

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const right = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 680 }, scaleFactor: 1.5 };

describe("placeScratchpad", () => {
  it("opens beside the pointer the first time, flipping away from the display's edges", () => {
    expect(placeScratchpad(null, { x: 100, y: 100 }, [primary])).toEqual({ x: 112, y: 112, ...SCRATCHPAD_SIZE });
    expect(placeScratchpad(null, { x: 1900, y: 1000 }, [primary])).toEqual({ x: 1900 - 480 - 12, y: 1000 - 320 - 12, ...SCRATCHPAD_SIZE });
    // On the second display, inside its own work area.
    const p = placeScratchpad(null, { x: 3150, y: 20 }, [primary, right]);
    expect(p.x).toBeGreaterThanOrEqual(1920);
    expect(p.x + p.width).toBeLessThanOrEqual(3200);
  });

  it("keeps the remembered place and size, pulled back on screen", () => {
    const saved = { x: 300, y: 200, width: 600, height: 400 };
    expect(placeScratchpad(saved, { x: 0, y: 0 }, [primary])).toEqual(saved);
    expect(placeScratchpad({ ...saved, x: 1700 }, { x: 0, y: 0 }, [primary])).toEqual({ ...saved, x: 1920 - 600 });
    // Its display is gone: back beside the pointer, at the remembered size.
    expect(placeScratchpad({ ...saved, x: 2500 }, { x: 100, y: 100 }, [primary])).toEqual({ x: 112, y: 112, width: 600, height: 400 });
  });
});
