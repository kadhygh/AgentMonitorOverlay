import { clampInto, displayFor, type DisplayInfo, type Point, type Rect, type Size } from "./placement.js";

// Where the scratchpad window goes (pure, unit-tested without Electron; DIP coordinates like placement.ts).

export const SCRATCHPAD_SIZE: Size = { width: 480, height: 320 };
export const SCRATCHPAD_MIN: Size = { width: 320, height: 200 };
/** Old AMO opened the scratchpad this far from the pointer. */
const CURSOR_OFFSET = 12;

/**
 * The remembered bounds if they still touch a display (pulled fully inside it); otherwise, as old AMO did, just below
 * and right of the pointer, flipped to the other side when that would leave the display.
 */
export function placeScratchpad(saved: Rect | null, cursor: Point, displays: readonly DisplayInfo[]): Rect {
  if (saved) {
    const touches = displays.some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y;
    });
    if (touches) return clampInto(saved, displayFor(saved, displays).workArea);
  }
  const { width, height } = saved ?? SCRATCHPAD_SIZE;
  const area = displayFor({ ...cursor, width: 1, height: 1 }, displays).workArea;
  let x = cursor.x + CURSOR_OFFSET;
  let y = cursor.y + CURSOR_OFFSET;
  if (x + width > area.x + area.width) x = cursor.x - width - CURSOR_OFFSET;
  if (y + height > area.y + area.height) y = cursor.y - height - CURSOR_OFFSET;
  return clampInto({ x, y, width, height }, area);
}
