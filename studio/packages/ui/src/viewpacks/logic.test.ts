import { describe, expect, it } from "vitest";
import type { ViewItem, ViewPack } from "@amo-studio/protocol";
import { itemToShow, packIdOf, proposalMessage } from "./logic.js";

const file = (id: string): ViewItem => ({ id, kind: "file", path: `${id}.ts`, highlights: [] });
const pack = (...ids: string[]): ViewPack => ({ id: "vp-1", workspaceId: "w", sessionId: null, title: "t", items: ids.map(file), createdAt: "", updatedAt: "" });

describe("查看包 window", () => {
  it("finds the pack a view_open or review_open call made, in any runtime's tool name", () => {
    const out = '{\n  "packId": "vp-0a1b-2c",\n  "title": "x"\n}';
    expect(packIdOf("mcp__amo__view_open", out)).toBe("vp-0a1b-2c");
    expect(packIdOf("amo.review_open", out)).toBe("vp-0a1b-2c");
    expect(packIdOf("view_open", out)).toBe("vp-0a1b-2c");
    expect(packIdOf("mcp__amo__session_start", out)).toBeNull();
    expect(packIdOf("mcp__amo__review_open", '{"target":{}}')).toBeNull();
  });

  it("shows what the agent just added, else stays where it was", () => {
    expect(itemToShow(null, pack("a", "b"), null)).toBe("a");
    expect(itemToShow(pack("a"), pack("a", "b", "c"), "a")).toBe("b");
    expect(itemToShow(pack("a", "b"), pack("a", "b"), "b")).toBe("b");
    expect(itemToShow(pack("a", "b"), pack("a", "b"), "gone")).toBe("a");
  });

  it("puts a proposal's comments in one message, by line", () => {
    const item = { id: "i", kind: "proposal", path: "src/drop.ts", original: "", proposed: "", isNew: false } as const;
    expect(
      proposalMessage({ title: "掉落" }, item, [
        { id: "2", side: "new", line: 4, lineText: "  d = 4", note: "不要" },
        { id: "1", side: "old", line: 2, lineText: "b = 20", note: "原来是对的" },
      ]),
    ).toBe("【对改动预览的批注】src/drop.ts（查看包「掉落」）\n- 原文件第 2 行 `b = 20`：原来是对的\n- 改后第 4 行 `d = 4`：不要");
  });
});
