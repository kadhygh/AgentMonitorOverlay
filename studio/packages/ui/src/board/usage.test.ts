import { describe, expect, it } from "vitest";
import { resetIn } from "./UsageFooter.js";

describe("resetIn", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  const at = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();
  it("counts down to the minute, with hours and days when there are any", () => {
    expect(resetIn(at(34), now)).toBe("34m");
    expect(resetIn(at(94), now)).toBe("1h 34m");
    expect(resetIn(at(120), now)).toBe("2h 0m");
    expect(resetIn(at(3 * 24 * 60 + 5), now)).toBe("3d 0h 5m");
    expect(resetIn(at(0.2), now)).toBe("1m");
    expect(resetIn(at(-1), now)).toBe("已重置");
  });
});
