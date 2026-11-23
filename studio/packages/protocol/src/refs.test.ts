import { describe, expect, it } from "vitest";
import { refId, sessionRefText, taskRefText } from "./refs.js";

// 复制引用 (2026-11-23): the lines Studio copies, and the ids an AI takes out of those the 中转 client copies.

describe("复制引用", () => {
  it("Studio's lines: a session's with this computer's device and its task, a task's", () => {
    expect(sessionRefText("射速文档", "d_1a2b", "s-99b524f2", "task-dba55279")).toBe("Studio 会话「射速文档」 studio:d_1a2b:s-99b524f2（任务 task-dba55279）");
    expect(sessionRefText("  多行\n名字 ", "d_1", "s-1", null)).toBe("Studio 会话「多行 名字」 studio:d_1:s-1");
    expect(sessionRefText("", "d_1", "s-1", null)).toBe("Studio 会话「会话」 studio:d_1:s-1");
    expect(taskRefText("射速上限可配", "task-dba55279")).toBe("任务「射速上限可配」 task-dba55279");
  });

  it("the id in each of the 中转 client's lines, the prefixed id alone, or a bare id", () => {
    expect(refId("协作「射速调整」 cowork:t_977a117f", "cowork")).toBe("t_977a117f");
    const sub = "子会话「射速曲线」 thread:t_40e55527（协作 cowork:t_977a117f）";
    expect(refId(sub, "thread")).toBe("t_40e55527");
    expect(refId(sub, "cowork")).toBe("t_977a117f");
    expect(refId("#271（协作「射速调整」 cowork:t_977a117f）", "cowork")).toBe("t_977a117f");
    expect(refId("中转会话「图标尺寸」 thread:t_5", "thread")).toBe("t_5");
    expect(refId(" cowork:t_9 ", "cowork")).toBe("t_9");
    expect(refId("thread:t_9", "thread")).toBe("t_9");
    expect(refId("t_9", "thread")).toBe("t_9");
    // A title naming the other kind is not taken; a line without that kind is passed on as it is (the tool then says it is not found).
    expect(refId("协作「thread:x 的讨论」 cowork:t_1", "thread")).toBe("协作「thread:x 的讨论」 cowork:t_1");
    expect(refId("协作「cowork:x」 cowork:t_1", "cowork")).toBe("t_1");
  });
});
