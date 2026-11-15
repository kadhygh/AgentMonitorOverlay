import { describe, expect, it } from "vitest";
import { STUDIO_SPARE_PORTS, standInPort } from "./ports.js";

describe("standInPort", () => {
  it("is a port of the spare range that none of the servers the test talks to has, given as urls or numbers", () => {
    const [lo, hi] = STUDIO_SPARE_PORTS;
    expect(standInPort()).toBe(hi);
    expect(standInPort(`http://127.0.0.1:${hi}`)).toBe(hi - 1);
    expect(standInPort(new URL(`http://127.0.0.1:${hi}/api`), hi - 1, `ws://127.0.0.1:${hi - 2}/`)).toBe(hi - 3);
    expect(standInPort(`http://127.0.0.1:${lo}`)).toBe(hi);
    const all = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    expect(() => standInPort(...all)).toThrow(/stand-in/);
  });
});
