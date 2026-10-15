import { afterEach, describe, expect, it } from "vitest";
import { READER_FRAMES, READER_H, READER_W, readerFrame } from "./readerGirl.js";
import { readPetSkin, writePetSkin } from "./petSkin.js";

describe("看书的 Claude 娘", () => {
  it("draws every frame of every mood on the 44×54 grid, outlined, inside the grid", () => {
    for (const [mood, { list }] of Object.entries(READER_FRAMES) as Array<[keyof typeof READER_FRAMES, { list: string[] }]>) {
      for (const frame of new Set(list)) {
        const px = readerFrame(mood, frame);
        expect(px).toHaveLength(READER_W * READER_H);
        const painted = px.filter(Boolean).length;
        expect(painted).toBeGreaterThan(READER_W * READER_H * 0.5);
        // The outline colour is the most used dark: the shape is closed.
        expect(px.filter((c) => c === "#3a2219").length).toBeGreaterThan(150);
      }
    }
  });

  it("each mood looks different: the 「!」 only when something needs the person, the vein only when angry", () => {
    const has = (mood: "alert" | "calm" | "angry", frame: string, colour: string) => readerFrame(mood, frame).includes(colour);
    expect(has("alert", "on", "mood")).toBe(true);
    expect(has("alert", "off", "mood")).toBe(false);
    expect(has("calm", "read", "mood")).toBe(false);
    expect(has("angry", "pulse", "#e5484d")).toBe(true);
    expect(has("calm", "read", "#e5484d")).toBe(false);
    // The page turns, and she blinks.
    expect(readerFrame("calm", "flip")).not.toEqual(readerFrame("calm", "read"));
    expect(readerFrame("calm", "blink")).not.toEqual(readerFrame("calm", "read"));
  });
});

describe("Focus 桌宠 setting", () => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  afterEach(() => data.clear());

  it("is the robot until the person picks her", () => {
    expect(readPetSkin()).toBe("robot");
    writePetSkin("reader");
    expect(readPetSkin()).toBe("reader");
    localStorage.setItem("amo.focusPet", "something else");
    expect(readPetSkin()).toBe("robot");
  });
});
