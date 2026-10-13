import { describe, expect, it } from "vitest";
import { answerValues, claudeAnswers, codexAnswers, elicitationForm, fieldDefault, formContent, isAnswered, storedAnswers, type QuestionPrompt } from "./questions.js";

const QUESTIONS: QuestionPrompt[] = [
  { id: "怎么重试？", question: "怎么重试？", options: [{ label: "指数退避" }, { label: "固定间隔", preview: "sleep(2)" }], other: true },
  { id: "记什么？", question: "记什么？", options: [{ label: "原因" }, { label: "次数" }, { label: "a, b" }], multiSelect: true, other: true },
  { id: "token", question: "令牌？", options: [], other: true, secret: true },
];

describe("answers", () => {
  it("tells answered from skipped", () => {
    expect(isAnswered({ id: "x", selected: ["a"] })).toBe(true);
    expect(isAnswered({ id: "x", selected: [], other: "  " })).toBe(false);
    expect(isAnswered({ id: "x", selected: ["a"], skipped: true })).toBe(false);
    expect(answerValues({ id: "x", selected: ["a", "b"], other: " c " })).toEqual(["a", "b", "c"]);
  });

  it("fills AskUserQuestion's answers the way Claude Code's dialog does", () => {
    expect(
      claudeAnswers(QUESTIONS, [
        { id: "怎么重试？", selected: ["固定间隔"] },
        { id: "记什么？", selected: ["原因", "a, b"], other: "还有 URL" },
        { id: "token", selected: [], skipped: true },
      ]),
    ).toEqual({
      answers: { "怎么重试？": "固定间隔", "记什么？": '原因, "a, b", 还有 URL' },
      annotations: { "怎么重试？": { preview: "sleep(2)" } },
    });
    // Free text replaces a single choice; nothing answered means no entry at all.
    expect(claudeAnswers(QUESTIONS, [{ id: "怎么重试？", selected: [], other: "看情况" }])).toEqual({ answers: { "怎么重试？": "看情况" } });
    expect(claudeAnswers(QUESTIONS, [])).toEqual({ answers: {} });
  });

  it("answers request_user_input by id", () => {
    expect(codexAnswers(QUESTIONS, [{ id: "token", selected: [], other: "abc" }, { id: "记什么？", selected: ["次数"] }])).toEqual({ answers: { "记什么？": { answers: ["次数"] }, token: { answers: ["abc"] } } });
  });

  it("stores answers with secrets masked and unknown labels dropped", () => {
    expect(storedAnswers(QUESTIONS, [{ id: "怎么重试？", selected: ["固定间隔", "bogus"] }, { id: "token", selected: [], other: "abc" }])).toEqual([
      { id: "怎么重试？", selected: ["固定间隔"] },
      { id: "记什么？", selected: [], skipped: true },
      { id: "token", selected: [], other: "（已隐藏）" },
    ]);
  });
});

describe("MCP forms", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "名字", minLength: 2, maxLength: 5 },
      mail: { type: "string", format: "email" },
      age: { type: "integer", minimum: 1, maximum: 120 },
      ratio: { type: "number", default: 0.5 },
      ok: { type: "boolean", description: "同意吗" },
      color: { type: "string", enum: ["r", "g"], enumNames: ["红", "绿"] },
      size: { type: "string", oneOf: [{ const: "s", title: "小" }, { const: "l", title: "大" }] },
      tags: { type: "array", items: { anyOf: [{ const: "a", title: "甲" }, { const: "b", title: "乙" }] }, minItems: 1 },
      plain: { type: "array", items: { type: "string", enum: ["x", "y"] }, default: ["x"] },
    },
    required: ["name", "color"],
  };

  it("reads every field kind from the schema", () => {
    const form = elicitationForm(schema)!;
    expect(form.map((f) => [f.name, f.kind, f.required, f.title])).toEqual([
      ["name", "text", true, "名字"],
      ["mail", "text", false, "mail"],
      ["age", "integer", false, "age"],
      ["ratio", "number", false, "ratio"],
      ["ok", "boolean", false, "ok"],
      ["color", "select", true, "color"],
      ["size", "select", false, "size"],
      ["tags", "multi", false, "tags"],
      ["plain", "multi", false, "plain"],
    ]);
    expect(form.find((f) => f.name === "color")!.options).toEqual([{ value: "r", label: "红" }, { value: "g", label: "绿" }]);
    expect(form.find((f) => f.name === "size")!.options).toEqual([{ value: "s", label: "小" }, { value: "l", label: "大" }]);
    expect(form.find((f) => f.name === "name")).toMatchObject({ min: 2, max: 5 });
    expect(form.find((f) => f.name === "mail")).toMatchObject({ format: "email" });
    expect(form.map(fieldDefault)).toEqual(["", "", "", 0.5, false, "", "", [], ["x"]]);
  });

  it("is no form without properties, or with a shape it cannot show", () => {
    expect(elicitationForm({ type: "object", properties: {} })).toBeNull();
    expect(elicitationForm(undefined)).toBeNull();
    expect(elicitationForm({ type: "object", properties: { x: { type: "object" } } })).toBeNull();
  });

  it("turns typed values into content and checks them", () => {
    const form = elicitationForm(schema)!;
    expect(formContent(form, { name: "张三", age: "30", ratio: "", ok: true, color: "g", tags: ["b", "zz"], plain: [] })).toEqual({
      content: { name: "张三", age: 30, ok: true, color: "g", tags: ["b"] },
    });
    expect(formContent(form, { name: "", color: "g" })).toMatchObject({ field: "name", error: "名字：必填" });
    expect(formContent(form, { name: "张", color: "g" })).toMatchObject({ field: "name" });
    expect(formContent(form, { name: "张三", color: "g", age: "1.5" })).toMatchObject({ field: "age", error: "age：要填整数" });
    expect(formContent(form, { name: "张三", color: "g", age: "500" })).toMatchObject({ field: "age" });
    expect(formContent(form, { name: "张三", color: "blue" })).toMatchObject({ field: "color" });
  });
});
