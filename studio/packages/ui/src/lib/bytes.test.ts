import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes.js";

describe("formatBytes", () => {
  it("one decimal from KB up to GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_800)).toBe("12.5 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatBytes(40 * 1024 * 1024)).toBe("40.0 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(3000 * 1024 ** 3)).toBe("3000.0 GB");
  });

  it("never shows 1024.0 of a unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3 - 1)).toBe("1.0 GB");
  });

  it("odd input reads as 0 B", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
});
