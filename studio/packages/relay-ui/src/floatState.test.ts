import { describe, expect, it } from "vitest";
import { cascade, clampRect, FLOAT_DEFAULT, FLOAT_MIN, FLOAT_STEP, floatsReduce, type FloatWin } from "./floatState.js";

const area = { w: 1000, h: 700 };
const open = (wins: FloatWin[], id: string, extra: Partial<Parameters<typeof floatsReduce>[1]> = {}) => floatsReduce(wins, { type: "open", id, title: id, area, ...extra } as Parameters<typeof floatsReduce>[1]);

describe("floating windows (协作's 子会话 and 白板)", () => {
  it("opens new ones a step down and right of the last, each on top", () => {
    let w = open([], "a");
    w = open(w, "b");
    w = open(w, "c");
    expect(w.map((x) => [x.rect.x, x.rect.y])).toEqual([
      [24, 16],
      [24 + FLOAT_STEP, 16 + FLOAT_STEP],
      [24 + 2 * FLOAT_STEP, 16 + 2 * FLOAT_STEP],
    ]);
    expect(w.map((x) => x.z)).toEqual([1, 2, 3]);
    expect(w[0]!.rect).toMatchObject(FLOAT_DEFAULT);
  });

  it("takes the first free step again once one closes; back at the top when the diagonal runs out", () => {
    let w = open(open([], "a"), "b");
    w = floatsReduce(w, { type: "close", id: "a" });
    w = open(w, "c");
    expect(w.find((x) => x.id === "c")!.rect).toMatchObject({ x: 24, y: 16 });
    const small = { w: 600, h: 500 };
    const taken = [0, 1, 2, 3].map((i) => ({ x: 24 + i * FLOAT_STEP, y: 16 + i * FLOAT_STEP, w: 520, h: 440 }));
    expect(cascade(taken, FLOAT_DEFAULT, small)).toMatchObject({ x: 24, y: 16 });
  });

  it("opens where it was kept, unless another is there now", () => {
    const saved = { x: 300, y: 120, w: 600, h: 400 };
    let w = open([], "a", { saved });
    expect(w[0]!.rect).toEqual(saved);
    w = open(w, "b", { saved });
    expect(w[1]!.rect).toMatchObject({ x: 24, y: 16, w: 600, h: 400 });
  });

  it("a click brings one to the front; opening one again unfolds it and brings it up", () => {
    let w = open(open([], "a"), "b");
    w = floatsReduce(w, { type: "focus", id: "a" });
    expect(w.find((x) => x.id === "a")!.z).toBeGreaterThan(w.find((x) => x.id === "b")!.z);
    const same = floatsReduce(w, { type: "focus", id: "a" });
    expect(same).toBe(w);
    w = floatsReduce(w, { type: "minimize", id: "a" });
    expect(w.find((x) => x.id === "a")!.minimized).toBe(true);
    w = open(w, "a", { title: "新标题" });
    expect(w.find((x) => x.id === "a")).toMatchObject({ minimized: false, title: "新标题" });
    expect(w).toHaveLength(2);
  });

  it("maximize toggles; moving it un-maximizes; moves and sizes stay inside the area and above the least size", () => {
    let w = floatsReduce(open([], "a"), { type: "toggleMax", id: "a" });
    expect(w[0]!.maximized).toBe(true);
    w = floatsReduce(w, { type: "move", id: "a", rect: { x: 900, y: -50, w: 100, h: 2000 }, area });
    expect(w[0]!.maximized).toBe(false);
    expect(w[0]!.rect).toEqual({ x: 1000 - FLOAT_MIN.w, y: 0, w: FLOAT_MIN.w, h: 700 });
  });

  it("brings windows back inside when the page gets smaller, and leaves them alone when nothing changes", () => {
    let w = floatsReduce(open([], "a", { saved: { x: 600, y: 300, w: 380, h: 380 } }), { type: "area", area });
    const before = w;
    w = floatsReduce(w, { type: "area", area });
    expect(w).toBe(before);
    w = floatsReduce(w, { type: "area", area: { w: 800, h: 500 } });
    expect(w[0]!.rect).toEqual({ x: 420, y: 120, w: 380, h: 380 });
    expect(clampRect({ x: 0, y: 0, w: 900, h: 900 }, { w: 200, h: 150 })).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });

  it("changes the title bar's words without moving it", () => {
    const w = floatsReduce(open([], "a", { status: "进行中" }), { type: "info", id: "a", status: "已定结论" });
    expect(w[0]).toMatchObject({ title: "a", status: "已定结论", rect: { x: 24, y: 16 } });
  });
});
