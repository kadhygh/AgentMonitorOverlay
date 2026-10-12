import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { presetDraft } from "./presets.js";

let root: string;
let ws: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-presets-"));
  ws = join(root, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "README.md"), "#");
  writeFileSync(join(ws, "src", "main.ts"), "");
});
afterEach(() => removeTempDir(root));

const base = { packDir: ".amo/packs/demo", taskTitle: "冲刺技能", profileIds: ["codex-mock", "claude-mock"] };

describe("presetDraft", () => {
  it("fills the variables, keeps the preset's model and lists the context files", () => {
    const d = presetDraft({
      ...base,
      workspace: { id: "w1", path: ws },
      preset: { id: "impl", title: "实现", profile: "claude-mock", prompt: "实现「{{task.title}}」，读 {{pack.dir}}/docs/a.md，工程在 {{ workspace.path }}", contextFiles: ["README.md", "src\\main.ts"] },
    });
    expect(d).toEqual({
      presetId: "impl",
      title: "实现",
      workspaceId: "w1",
      profileId: "claude-mock",
      text: `实现「冲刺技能」，读 .amo/packs/demo/docs/a.md，工程在 ${ws}\n\n相关文件（开始前请先阅读）：\n- README.md\n- src/main.ts`,
      contextFiles: ["README.md", "src/main.ts"],
      warnings: [],
    });
  });

  it("falls back to the default model and skips files that are missing or lead outside", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "s");
    symlinkSync(outside, join(ws, "linked"), process.platform === "win32" ? "junction" : "dir");
    const d = presetDraft({
      ...base,
      taskTitle: "",
      workspace: { id: "w1", path: ws },
      preset: { id: "p", title: "P", profile: "nope", prompt: "做 {{task.title}}", contextFiles: ["missing.md", "linked/secret.md"] },
    });
    expect(d.profileId).toBeNull();
    expect(d.text).toBe("做 （未命名任务）");
    expect(d.contextFiles).toEqual([]);
    expect(d.warnings).toEqual([
      "相关文件 missing.md 不存在，或指到了工作区外面，已略过",
      "相关文件 linked/secret.md 不存在，或指到了工作区外面，已略过",
      "没有模型配置 nope，改用默认模型",
    ]);
  });

  it("uses the default model when the preset names none", () => {
    expect(presetDraft({ ...base, workspace: { id: "w1", path: ws }, preset: { id: "p", title: "P", prompt: "x" } })).toMatchObject({ profileId: null, warnings: [], text: "x" });
  });
});
