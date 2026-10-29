import { describe, expect, it } from "vitest";
import { backTo, withOrigin } from "./views.js";

describe("where a task page returns", () => {
  it("remembers the board or canvas it was opened from", () => {
    expect(withOrigin({ kind: "task", taskId: "t1" }, { kind: "canvas" })).toEqual({ kind: "task", taskId: "t1", back: { kind: "canvas" } });
    expect(withOrigin({ kind: "new" }, { kind: "board" })).toEqual({ kind: "new", back: { kind: "board" } });
    const page = withOrigin({ kind: "new" }, { kind: "canvas" });
    expect(backTo(page.kind === "new" ? page.back : undefined)).toEqual({ view: { kind: "canvas" }, label: "画布" });
  });

  it("passes the origin on from page to page: new task → its task page, a task → another one", () => {
    const fromCanvas = withOrigin({ kind: "new" }, { kind: "canvas" });
    expect(withOrigin({ kind: "task", taskId: "t2", sessionId: "s" }, fromCanvas)).toEqual({ kind: "task", taskId: "t2", sessionId: "s", back: { kind: "canvas" } });
    const task = withOrigin({ kind: "task", taskId: "t1" }, { kind: "canvas" });
    expect(withOrigin({ kind: "task", taskId: "t3", nav: 5 }, task)).toMatchObject({ taskId: "t3", back: { kind: "canvas" } });
  });

  it("远程 remembers where it was opened from, and a task opened from it returns to it", () => {
    const remote = withOrigin({ kind: "remote" }, { kind: "task", taskId: "t1", back: { kind: "canvas" } });
    expect(remote).toEqual({ kind: "remote", back: { kind: "canvas" } });
    expect(withOrigin({ kind: "remote", nav: 2 }, remote)).toEqual({ kind: "remote", nav: 2, back: { kind: "canvas" } });
    const task = withOrigin({ kind: "task", taskId: "t2" }, remote);
    expect(task).toEqual({ kind: "task", taskId: "t2", back: remote });
    expect(backTo(task.kind === "task" ? task.back : undefined)).toEqual({ view: remote, label: "远程" });
    expect(withOrigin({ kind: "remote" }, task)).toEqual({ kind: "remote", back: { kind: "canvas" } });
  });

  it("keeps a page's own origin, and leaves other pages alone", () => {
    expect(withOrigin({ kind: "task", taskId: "t1", back: { kind: "board" } }, { kind: "canvas" })).toEqual({ kind: "task", taskId: "t1", back: { kind: "board" } });
    expect(withOrigin({ kind: "canvas" }, { kind: "task", taskId: "t1", back: { kind: "board" } })).toEqual({ kind: "canvas" });
    expect(withOrigin({ kind: "task", taskId: "t1" }, { kind: "packs", workspaceId: "w" })).toEqual({ kind: "task", taskId: "t1" });
  });
});
