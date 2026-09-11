export interface InputRect { x: number; y: number; width: number; height: number }
export interface InputRegionPayload { mode: "regions" | "full"; viewportWidth: number; viewportHeight: number; rects: InputRect[] }
export function intersectRect(a: InputRect, b: InputRect): InputRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
export function regionPayload(rects: InputRect[], width: number, height: number, full = false): InputRegionPayload {
  const viewportWidth = Math.max(1, Math.min(32768, Number.isFinite(width) ? width : 1)), viewportHeight = Math.max(1, Math.min(32768, Number.isFinite(height) ? height : 1));
  const viewport = { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
  const clipped = rects.filter(rect => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    .map(rect => intersectRect(rect, viewport)).filter((rect): rect is InputRect => rect !== null)
    .map(rect => ({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x), height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y) }));
  const unique = [...new Map(clipped.map(rect => [JSON.stringify(rect), rect])).values()];
  // Never hide the entire native window if the UI is between layouts or unavailable.
  return { mode: full || !unique.length || unique.length > 512 ? "full" : "regions", viewportWidth, viewportHeight, rects: full || unique.length > 512 ? [] : unique };
}

export function measureInputRegions(root: HTMLElement): InputRect[] {
  const viewport = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const result: InputRect[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-focus-region]")) {
    if (!element.getClientRects().length) continue;
    const bounds = element.getBoundingClientRect();
    let rect: InputRect | null = { x: bounds.x - 5, y: bounds.y - 5, width: bounds.width + 10, height: bounds.height + 10 };
    for (let parent = element.parentElement; parent && rect; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      const clipX = /auto|scroll|hidden|clip/.test(style.overflowX), clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (clipX || clipY) rect = intersectRect(rect, { x: clipX ? box.x : viewport.x, y: clipY ? box.y : viewport.y, width: clipX ? box.width : viewport.width, height: clipY ? box.height : viewport.height });
    }
    if (rect) result.push(rect);
  }
  // Keep the native scrollbar usable; transparent space elsewhere passes through.
  const scroller = root.querySelector<HTMLElement>(".amo-focus-lanes");
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
    const box = scroller.getBoundingClientRect();
    result.push({ x: box.right - 12, y: box.y, width: 12, height: box.height });
  }
  return result;
}
