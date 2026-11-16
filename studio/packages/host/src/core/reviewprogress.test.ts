import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store, newId } from "../store/store.js";
import { readReviewProgress, replyOpening, reviewProgressHint, writeReviewProgress } from "./reviewprogress.js";

// 审阅进度 (2026-11-16): what the AI is told with the person's next message — the blocks newly marked 「!」 and how far
// the last reply was read when only partly — and only once.

let root: string;
let store: Store;
let main: Session;

const row = (body: Record<string, unknown>): SessionItem => store.appendItem({ id: newId("item"), sessionId: main.id, createdAt: new Date().toISOString(), ...body } as never);
const agent = (markdown: string) => row({ type: "agent", markdown, streaming: false }).id;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-review-hint-"));
  store = new Store(join(root, "studio.db"));
  mkdirSync(join(root, "alpha"));
  const ws = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const task = store.createTask({ title: "掉落表", workspaceId: ws.id });
  main = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-1" });
});

afterEach(() => {
  store.close();
  removeTempDir(root);
});

describe("审阅进度 told to the AI", () => {
  it("says nothing when nothing was marked, or the last reply was read to the end or not at all", () => {
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
    const a = agent("一段\n\n两段");
    writeReviewProgress(store, main.id, { replies: { [a]: { read: 2, of: 2, at: "两段", flags: [] } } });
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
    writeReviewProgress(store, main.id, { replies: { [a]: { read: "all", flags: [] } } });
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
  });

  it("tells the new 「!」 by the reply's first words and the block's, once", () => {
    const a = agent("## 掉落表怎么合\n\n我先看了现有的 70 张 Boss 掉落表，结论是可以合。\n\n- 第二条");
    const b = agent("**改完了**，说一下结果。");
    writeReviewProgress(store, main.id, {
      replies: {
        [b]: { read: "all", flags: [{ block: 0, quote: "改完了，说一下结果。" }] },
        [a]: { read: 1, of: 2, at: "我先看了现有的…", flags: [{ block: 1, quote: "第二条" }] },
      },
    });
    const hint = reviewProgressHint(store, main.id);
    expect(hint.lines).toEqual([
      "人在你的回复上标了 2 处「有问题」（人只标了是哪一段，没写哪里不对：这条消息里说了的照人说的办，没说的先自己重看这一段、找出可能的问题，拿不准就问人）：",
      "· 你那条开头是「掉落表怎么合」的回复里，第 2 段「第二条」",
      "· 你那条开头是「改完了，说一下结果。」的回复里，第 1 段「改完了，说一下结果。」",
    ]);
    hint.told();
    expect(readReviewProgress(store, main.id).replies[a]!.flags).toEqual([{ block: 1, quote: "第二条", told: true }]);
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
  });

  it("tells how far the last reply was read when only partly, once for each place", () => {
    agent("更早的一条");
    const last = agent("第一段\n\n第二段\n\n第三段");
    writeReviewProgress(store, main.id, { replies: { [last]: { read: 1, of: 3, at: "第一段", flags: [] } } });
    const hint = reviewProgressHint(store, main.id);
    expect(hint.lines).toEqual(["人读你上一条回复读到第 1 段「第一段」为止，后面的 2 段还没读：别把没读的部分当成人已经看过、同意了。"]);
    hint.told();
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
    // Read further: said again, with the new place.
    writeReviewProgress(store, main.id, { ...readReviewProgress(store, main.id), replies: { [last]: { read: 2, of: 3, at: "第二段", flags: [] } } });
    expect(reviewProgressHint(store, main.id).lines).toEqual(["人读你上一条回复读到第 2 段「第二段」为止，后面的 1 段还没读：别把没读的部分当成人已经看过、同意了。"]);
    // A newer reply nobody marked: nothing about the older one.
    agent("新的回复");
    expect(reviewProgressHint(store, main.id).lines).toEqual([]);
  });

  it("takes a reply's first words without Markdown's marks", () => {
    expect(replyOpening("\n\n## 一、表怎么合\n正文")).toBe("一、表怎么合");
    expect(replyOpening("- **加例外行**：30 / 31 级")).toBe("加例外行：30 / 31 级");
    expect(replyOpening("看 [这份方案](plans/a.md) 和 `BossDrop` 表里的第一列，下面分三步说")).toBe("看 这份方案 和 BossDrop 表里…");
    expect(replyOpening("")).toBe("");
  });
});
