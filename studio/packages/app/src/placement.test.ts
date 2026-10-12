import { describe, expect, it } from "vitest";
import { clampInto, displayFor, placeFocus, placeMain, refitFocus, type DisplayInfo } from "./placement.js";

// Primary 1920x1080 at 100% (taskbar 40 high); a 4K monitor at 150% on its left (2560x1440 DIP, above the origin);
// a 1280x1024 at 125% on its right.
const primary: DisplayInfo = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const left4k: DisplayInfo = { id: 2, scaleFactor: 1.5, workArea: { x: -2560, y: -400, width: 2560, height: 1400 } };
const right: DisplayInfo = { id: 3, scaleFactor: 1.25, workArea: { x: 1920, y: 0, width: 1024, height: 779 } };
const all = [primary, left4k, right];
const focusSize = { width: 380, height: 560 };

describe("placement", () => {
  it("finds the display a window mostly lies on, or the nearest one", () => {
    expect(displayFor({ x: -300, y: 100, width: 400, height: 300 }, all).id).toBe(2);
    expect(displayFor({ x: 1800, y: 100, width: 400, height: 300 }, all).id).toBe(3);
    expect(displayFor({ x: 5000, y: 100, width: 100, height: 100 }, all).id).toBe(3);
  });

  it("clamps into an area, shrinking when it does not fit", () => {
    expect(clampInto({ x: 1800, y: 900, width: 380, height: 560 }, primary.workArea)).toEqual({ x: 1540, y: 480, width: 380, height: 560 });
    expect(clampInto({ x: 0, y: 0, width: 1440, height: 900 }, right.workArea)).toEqual({ x: 1920, y: 0, width: 1024, height: 779 });
  });

  describe("Focus", () => {
    it("defaults to the primary display's bottom-right corner", () => {
      expect(placeFocus(null, focusSize, all, 1)).toEqual({ x: 1920 - 380 - 12, y: 1040 - 560 - 12 });
    });

    it("keeps a remembered position on another display, including negative coordinates", () => {
      expect(placeFocus({ x: -500, y: 300 }, focusSize, all, 1)).toEqual({ x: -500, y: 300 });
    });

    it("pulls a half-visible position inside, and resets one on a display that is gone", () => {
      expect(placeFocus({ x: 1700, y: 600 }, focusSize, all, 1)).toEqual({ x: 1540, y: 480 });
      expect(placeFocus({ x: 4000, y: 300 }, focusSize, all, 1)).toEqual({ x: 1528, y: 468 });
    });

    it("refits after a display is unplugged or rescaled", () => {
      const onRight = { x: 2500, y: 200, ...focusSize };
      expect(refitFocus(onRight, all, 1)).toEqual({ x: 2500, y: 200 });
      // The right display is unplugged: back to the primary's corner.
      expect(refitFocus(onRight, [primary, left4k], 1)).toEqual({ x: 1528, y: 468 });
      // The right display goes to 175%: its work area shrinks and the window is pulled back inside.
      const shrunk = { ...right, scaleFactor: 1.75, workArea: { x: 1920, y: 0, width: 731, height: 556 } };
      expect(refitFocus(onRight, [primary, left4k, shrunk], 1)).toEqual({ x: 1920 + 731 - 380, y: 0 });
    });
  });

  describe("main window", () => {
    const size = { width: 1440, height: 900 };

    it("centres the default size on the primary display, shrinking to fit", () => {
      expect(placeMain(null, size, all, 1)).toEqual({ x: 240, y: 70, width: 1440, height: 900 });
      expect(placeMain(null, size, all, 3)).toEqual({ x: 1920, y: 0, width: 1024, height: 779 });
    });

    it("restores remembered bounds on any display", () => {
      const saved = { x: -2400, y: -300, width: 1600, height: 1000 };
      expect(placeMain(saved, size, all, 1)).toEqual(saved);
    });

    it("pulls bounds back when the title bar is off every display", () => {
      expect(placeMain({ x: 100, y: -500, width: 1440, height: 900 }, size, [primary], 1)).toEqual({ x: 240, y: 70, width: 1440, height: 900 });
      expect(placeMain({ x: 5000, y: 100, width: 1440, height: 900 }, size, all, 1)).toEqual({ x: 240, y: 70, width: 1440, height: 900 });
    });

    it("shrinks remembered bounds that no longer fit their display", () => {
      expect(placeMain({ x: 1950, y: 10, width: 1440, height: 900 }, size, all, 1)).toEqual({ x: 1920, y: 0, width: 1024, height: 779 });
    });
  });
});
