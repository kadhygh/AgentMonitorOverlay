import { describe, expect, it } from "vitest";
import { modelName, sessionModelName } from "./choices.js";

describe("model names", () => {
  it("reads Claude Code's default entry as the model inside it", () => {
    expect(modelName({ id: "default", label: "默认（Opus 5.5）" })).toBe("Opus 5.5");
    expect(modelName({ id: "default", label: "默认（Opus 5.5 · 1M context）" })).toBe("Opus 5.5");
    expect(modelName({ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" })).toBe("GPT-6.1 Sol");
    expect(modelName(undefined)).toBeNull();
  });

  it("names the model a session runs, the profile's default when none was chosen", () => {
    const choices = { profileId: "p", permissions: [], defaultPermission: "ask", source: "cli" as const, models: [{ id: "a", label: "Sol 6.1", efforts: [], isDefault: true }, { id: "b", label: "Luna", efforts: [] }] };
    expect(sessionModelName(choices, {})).toBe("Sol 6.1");
    expect(sessionModelName(choices, { model: "b" })).toBe("Luna");
    expect(sessionModelName(null, { model: "b" })).toBe("b");
    expect(sessionModelName(null, {})).toBeNull();
  });
});
