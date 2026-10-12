import { describe, expect, it } from "vitest";
import { presetVariables, renderPresetPrompt, safeRelativePath, validatePackManifest } from "./packs.js";

const valid = {
  schemaVersion: 1,
  name: "demo",
  title: "示例扩展包",
  description: "虚构内容",
  docs: [{ id: "style", title: "代码规范", path: "docs/style.md", summary: "命名与目录" }],
  templates: [{ id: "feature", title: "新功能", titlePrefix: "[功能]", steps: ["读规范", "实现", "补测试"] }],
  presets: [{ id: "impl", title: "实现", profile: "codex-deepseek-flash", prompt: "实现「{{task.title}}」，先读 {{pack.dir}}/docs/style.md", contextFiles: ["src\\main.ts"] }],
  tools: [{ name: "weapon_lookup", description: "以后再做" }],
};

describe("validatePackManifest", () => {
  it("accepts a complete manifest and normalises it", () => {
    const r = validatePackManifest(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.templates[0]?.titlePrefix).toBe("[功能] ");
    expect(r.manifest.presets[0]?.contextFiles).toEqual(["src/main.ts"]);
    expect(r.manifest.tools).toEqual([{ name: "weapon_lookup", description: "以后再做" }]);
    expect(r.warnings).toEqual(["tools: 专用工具目前只是预留，不会运行"]);
  });

  it("accepts a minimal manifest", () => {
    expect(validatePackManifest({ schemaVersion: 1, name: "min", title: "最小" })).toMatchObject({ ok: true, manifest: { docs: [], templates: [], presets: [], tools: [] }, warnings: [] });
  });

  it("names the field that is wrong", () => {
    const r = validatePackManifest({
      ...valid,
      schemaVersion: 2,
      name: "Bad Name",
      docs: [{ id: "a", title: "A", path: "a.md" }, { id: "a", title: "", path: "b.md" }],
      templates: [{ id: "t", title: "T", steps: [] }],
      presets: [{ id: "p", title: "P", prompt: "{{task.id}} {{ task.title }}" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      "schemaVersion: 应为 1",
      "name: 应为小写字母、数字、- 或 _，最长 40 个字符",
      'docs[1].id: 重复的 id "a"',
      "docs[1].title: 必填，应为字符串",
      "templates[0].steps: 至少要有一步",
      "presets[0].prompt: 未知变量 {{task.id}}（可用：task.title、workspace.path、pack.dir）",
    ]);
  });

  it("rejects paths that leave the pack or the workspace", () => {
    for (const path of ["../secret.md", "docs/../../x.md", "C:\\Windows\\win.ini", "/etc/passwd", "\\\\server\\share\\x", "~/x", "a.md:stream", "", "./"]) {
      const r = validatePackManifest({ ...valid, docs: [{ id: "d", title: "D", path }] });
      expect(r.ok, path).toBe(false);
    }
    const r = validatePackManifest({ ...valid, presets: [{ id: "p", title: "P", prompt: "x", contextFiles: ["ok.ts", "..\\up.ts"] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['presets[0].contextFiles[1]: 路径 "..\\up.ts" 不允许（只能是相对路径，不能含 ".." 或盘符）']);
  });

  it("bounds sizes and counts", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `d${i}`, title: "D", path: `d${i}.md` }));
    const r = validatePackManifest({ ...valid, title: "x".repeat(101), docs: many, presets: [{ id: "p", title: "P", prompt: "x".repeat(8001) }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["title: 太长（101 字，最多 100）", "docs: 太多（51 项，最多 50）", "presets[0].prompt: 太长（8001 字，最多 8000）"]);
  });

  it("warns about unknown keys and rejects non-objects", () => {
    expect(validatePackManifest({ ...valid, hooks: [] }).warnings).toContain('未知字段 "hooks"，已忽略');
    expect(validatePackManifest([])).toEqual({ ok: false, errors: ["pack.json: 应为对象"], warnings: [] });
    expect(validatePackManifest({ ...valid, docs: "x" })).toMatchObject({ ok: false, errors: ["docs: 应为数组"] });
  });
});

describe("paths and prompts", () => {
  it("normalises safe relative paths", () => {
    expect(safeRelativePath("./docs\\a.md")).toBe("docs/a.md");
    expect(safeRelativePath("docs//b/./c.md")).toBe("docs/b/c.md");
    expect(safeRelativePath("..")).toBeNull();
  });

  it("finds and fills preset variables, leaving unknown ones as they are", () => {
    expect(presetVariables("a {{task.title}} b {{ pack.dir }}")).toEqual(["task.title", "pack.dir"]);
    expect(renderPresetPrompt("「{{task.title}}」在 {{ workspace.path }}，{{other}}", { "task.title": "导入", "workspace.path": "D:/w", "pack.dir": "D:/w/.amo/packs/demo" })).toBe("「导入」在 D:/w，{{other}}");
  });
});
