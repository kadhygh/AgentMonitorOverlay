import { describe, expect, it } from "vitest";
import { summarize } from "./stall-profiler.js";

describe("summarize", () => {
  it("names the frames the last stall ran in, and the stack of the busiest", () => {
    const frame = (functionName: string, lineNumber = 0) => ({ functionName, url: "file:///G:/studio/dist/main.js", lineNumber });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2] },
        { id: 2, callFrame: frame("onOpen", 9), children: [3, 4] },
        { id: 3, callFrame: frame("readBig", 19) },
        { id: 4, callFrame: frame("tick", 29) },
      ],
      startTime: 0,
      endTime: 3_000_000,
      // 1 s of ticks long before; then 2 s mostly in readBig.
      samples: [4, 4, 3, 3, 3, 4],
      timeDeltas: [0, 100_000, 1_000_000, 500_000, 500_000, 500_000],
    };
    const text = summarize(profile, 2000);
    expect(text).toMatch(/^4 samples; most: readBig main\.js:20 75%, tick main\.js:30 25%; stack of the first: readBig main\.js:20 < onOpen main\.js:10$/);
  });
});
