import { describe, expect, it } from "vitest";
import type { FormField, QuestionPrompt, SessionItem } from "@amo-studio/protocol";
import { advance, answersSummary, answerText, choose, formSummary, isLongPlan, pendingQuestion, planTitle, skipAndMaybeSubmit, startFlow, toAnswers, typeOther, type QuestionItem } from "./flow.js";

const QS: QuestionPrompt[] = [
  { id: "a", question: "单选？", options: [{ label: "甲" }, { label: "乙" }], other: true },
  { id: "b", question: "多选？", options: [{ label: "一" }, { label: "二" }, { label: "三" }], multiSelect: true, other: true },
];

describe("question flow", () => {
  it("moves on after a single choice and toggles multi-select", () => {
    let f = startFlow(QS);
    f = choose(f, QS, "乙");
    expect(f.index).toBe(1);
    expect(f.drafts[0]).toEqual({ selected: ["乙"], other: "", skipped: false });
    f = choose(f, QS, "一");
    f = choose(f, QS, "三");
    f = choose(f, QS, "一");
    expect(f.index).toBe(1);
    expect(f.drafts[1]!.selected).toEqual(["三"]);
  });

  it("lets free text replace a single choice but sit beside multi-select ticks", () => {
    let f = choose(startFlow(QS), QS, "甲");
    f = typeOther({ ...f, index: 0 }, QS, "都不要");
    expect(f.drafts[0]).toEqual({ selected: [], other: "都不要", skipped: false });
    f = choose({ ...f, index: 1 }, QS, "二");
    f = typeOther(f, QS, "四");
    expect(f.drafts[1]).toEqual({ selected: ["二"], other: "四", skipped: false });
    expect(toAnswers(QS, f.drafts)).toEqual([
      { id: "a", selected: [], other: "都不要" },
      { id: "b", selected: ["二"], other: "四" },
    ]);
  });

  it("asks for an answer, goes back to what is open, then submits", () => {
    let f = startFlow(QS);
    expect(advance(f, QS).error).toBeTruthy();
    f = { ...f, index: 1 };
    f = choose(f, QS, "二");
    const back = advance(f, QS);
    expect(back).toMatchObject({ error: "还有问题没有回答", flow: { index: 0 } });
    f = choose(back.flow, QS, "甲");
    const done = advance({ ...f, index: 1 }, QS);
    expect(done.submit).toEqual([
      { id: "a", selected: ["甲"] },
      { id: "b", selected: ["二"] },
    ]);
  });

  it("submits when the last question is skipped", () => {
    let f = choose(startFlow(QS), QS, "甲");
    const r = skipAndMaybeSubmit(f, QS);
    expect(r.submit).toEqual([
      { id: "a", selected: ["甲"] },
      { id: "b", selected: [], skipped: true },
    ]);
    f = skipAndMaybeSubmit(startFlow(QS), QS).flow;
    expect(f).toMatchObject({ index: 1, drafts: [{ skipped: true }, { skipped: false }] });
  });
});

const base = { sessionId: "s", seq: 1, createdAt: "2026-10-14T00:00:00Z" };
const item = (over: Partial<QuestionItem>): QuestionItem => ({ ...base, id: "q", type: "question", source: "claude-ask", state: "pending", questions: QS, ...over }) as QuestionItem;

describe("reading questions", () => {
  it("finds the oldest pending question", () => {
    const items = [item({ id: "q1", state: "answered" }), item({ id: "q2" }), item({ id: "q3" })] as SessionItem[];
    expect(pendingQuestion(items)?.id).toBe("q2");
    expect(pendingQuestion([])).toBeNull();
  });

  it("summarises answers", () => {
    expect(answersSummary(item({ state: "answered", answers: [{ id: "a", selected: ["甲"] }, { id: "b", selected: ["一", "二"], other: "四" }] }))).toBe("甲 · 一、二、四");
    expect(answersSummary(item({ state: "answered", answers: [{ id: "a", selected: [], skipped: true }, { id: "b", selected: [], skipped: true }] }))).toBe("全部跳过");
    expect(answerText(undefined)).toBe("已跳过");
    const form: FormField[] = [
      { name: "n", kind: "text", title: "名字", required: true },
      { name: "ok", kind: "boolean", title: "通知", required: false },
      { name: "c", kind: "select", title: "渠道", required: false, options: [{ value: "s", label: "Steam" }] },
    ];
    expect(formSummary(form, { n: "x", ok: false, c: "s" })).toBe("名字：x · 通知：否 · 渠道：Steam");
  });

  it("titles and folds plans", () => {
    expect(planTitle("\n# 给导入器加重试\n\n正文")).toBe("给导入器加重试");
    expect(planTitle("先做 A\n再做 B")).toBe("先做 A");
    expect(planTitle("")).toBe("计划");
    expect(isLongPlan("a\nb")).toBe(false);
    expect(isLongPlan(Array.from({ length: 30 }, (_, i) => `${i}`).join("\n"))).toBe(true);
  });
});
