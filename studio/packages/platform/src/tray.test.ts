import { describe, expect, it } from "vitest";
import { trayClickAction, trayMenu, type TrayItem, type TrayState } from "./tray.js";

const labels = (items: TrayItem[]) => items.map((i) => (i.kind === "separator" ? "—" : i.kind === "heading" ? `# ${i.label}` : i.kind === "radio" ? `${i.checked ? "●" : "○"} ${i.label}` : i.label));

const all: TrayState = {
  tools: [
    { id: "studio", name: "AMO Studio" },
    { id: "relay", name: "AMO 中转" },
    { id: "reviewer", name: "AMO Reviewer" },
  ],
  notes: true,
  studioRestart: false,
  studioVersion: "0.9.7",
  click: "notes",
};

describe("the platform's tray menu (2026-10-29)", () => {
  it("lists every tool's items in one part each, not folded, with the click choice at the bottom", () => {
    expect(labels(trayMenu(all))).toEqual([
      "# AMO Studio",
      "打开 Studio",
      "完全退出 Studio",
      "—",
      "# AMO 便签",
      "显示 / 隐藏便签",
      "退出便签",
      "—",
      "# AMO 中转",
      "打开中转",
      "退出中转",
      "—",
      "# AMO Reviewer",
      "打开 Reviewer",
      "—",
      "# AMO 平台",
      "打开 AMO 平台",
      "● 单击图标：打开便签",
      "○ 单击图标：打开 Studio",
      "退出平台",
    ]);
    // 重启 Studio when the Host is older and idle.
    expect(labels(trayMenu({ ...all, studioRestart: true }))).toContain("重启 Studio（换成 0.9.7）");
  });

  it("a click opens 便签 or Studio as chosen, falling back to what is there", () => {
    expect(trayClickAction(all)).toEqual({ kind: "toggle-notes" });
    expect(trayClickAction({ ...all, click: "studio" })).toEqual({ kind: "open", tool: "studio" });
    expect(trayClickAction({ ...all, notes: false })).toEqual({ kind: "open", tool: "studio" });
    expect(trayClickAction({ ...all, tools: [], notes: false })).toEqual({ kind: "show-platform" });
    // Nothing installed: only the platform's part.
    expect(labels(trayMenu({ ...all, tools: [], notes: false }))).toEqual(["# AMO 平台", "打开 AMO 平台", "退出平台"]);
  });

  it("something waiting in 中转: its item says how much, and a click opens it (the icon is 中转's then)", () => {
    expect(labels(trayMenu({ ...all, relayCount: 3 }))).toContain("打开中转（3 条待处理 / 未读）");
    expect(trayClickAction({ ...all, relayCount: 3 })).toEqual({ kind: "open", tool: "relay" });
    expect(trayClickAction({ ...all, relayCount: 0 })).toEqual({ kind: "toggle-notes" });
    // 中转 not installed through the platform: the click stays as chosen.
    expect(trayClickAction({ ...all, tools: all.tools.filter((t) => t.id !== "relay"), relayCount: 3 })).toEqual({ kind: "toggle-notes" });
  });
});
