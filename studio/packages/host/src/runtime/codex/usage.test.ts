import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { codexUsage } from "./codex-runtime.js";

const GPT: ModelProfile = { id: "codex-default", label: "GPT", runtime: "codex", provider: null, model: null };

describe("codexUsage", () => {
  it("turns the 5-hour and weekly windows into labelled percentages with reset times", () => {
    const u = codexUsage(GPT, {
      primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: null },
    });
    expect(u).toMatchObject({ profileId: "codex-default", label: "GPT", note: null });
    expect(u.windows).toEqual([
      { label: "5 小时", usedPercent: 32, resetsAt: new Date(1_800_000_000_000).toISOString() },
      { label: "每周", usedPercent: 8, resetsAt: null },
    ]);
    expect(codexUsage(GPT, { primary: null, secondary: null }).note).toBe("这个账号没有用量限制");
  });
});
