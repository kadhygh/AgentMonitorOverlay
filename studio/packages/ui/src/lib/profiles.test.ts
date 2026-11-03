import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { repick } from "./profiles.js";

const p = (id: string, extra: Partial<ModelProfile> = {}) => ({ id, label: id, runtime: "codex", ...extra }) as ModelProfile;

// 问题 #14 (2026-11-03): a form's model follows 设置 → 模型's 隐藏 instead of keeping the one it opened with.
describe("repick", () => {
  it("leaves a model that can still be picked", () => {
    expect(repick([p("codex-default"), p("claude-subscription")], "codex-default")).toBeNull();
  });
  it("moves off a model hidden meanwhile", () => {
    expect(repick([p("codex-default", { hidden: true }), p("claude-subscription")], "codex-default")).toBe("claude-subscription");
  });
  it("moves off a model that can no longer start sessions, or is gone", () => {
    expect(repick([p("dsh", { unavailable: "没有 DSH" }), p("codex-default")], "dsh")).toBe("codex-default");
    expect(repick([p("codex-default")], "removed-channel")).toBe("codex-default");
  });
  it("fills an empty pick once the models are there, and waits while there are none", () => {
    expect(repick([p("codex-default")], "")).toBe("codex-default");
    expect(repick([], "")).toBeNull();
  });
  it("does not loop when nothing can be picked", () => {
    expect(repick([p("codex-default", { hidden: true })], "codex-default")).toBeNull();
  });
});
