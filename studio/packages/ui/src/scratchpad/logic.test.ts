import { describe, expect, it } from "vitest";
import { clipboardText, pageFromKey, shortcutFromKey, shortcutLabel } from "./logic.js";

const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, k = code) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
  key: k,
  code,
});

describe("pageFromKey", () => {
  it("switches pages with Ctrl+1…9 within the page count", () => {
    expect(pageFromKey(key("Digit1", { ctrlKey: true }, "1"), 3)).toBe(0);
    expect(pageFromKey(key("Digit3", { ctrlKey: true }, "3"), 3)).toBe(2);
    expect(pageFromKey(key("Numpad2", { ctrlKey: true }, "2"), 3)).toBe(1);
    expect(pageFromKey(key("Digit4", { ctrlKey: true }, "4"), 3)).toBeNull();
    expect(pageFromKey(key("Digit1", {}, "1"), 3)).toBeNull();
    expect(pageFromKey(key("Digit1", { ctrlKey: true, shiftKey: true }, "!"), 3)).toBeNull();
    expect(pageFromKey(key("Digit0", { ctrlKey: true }, "0"), 9)).toBeNull();
  });
});

describe("shortcutFromKey", () => {
  it("builds the shortcut from where the keys are, not what they type", () => {
    expect(shortcutFromKey(key("Space", { ctrlKey: true, altKey: true }, " "))).toEqual({ shortcut: "Ctrl+Alt+Space" });
    expect(shortcutFromKey(key("Digit1", { ctrlKey: true, shiftKey: true }, "!"))).toEqual({ shortcut: "Ctrl+Shift+1" });
    expect(shortcutFromKey(key("KeyZ", { altKey: true, metaKey: true }, "z"))).toEqual({ shortcut: "Alt+Super+Z" });
    expect(shortcutFromKey(key("F9", {}, "F9"))).toEqual({ shortcut: "F9" });
    expect(shortcutFromKey(key("ArrowUp", { ctrlKey: true }, "ArrowUp"))).toEqual({ shortcut: "Ctrl+Up" });
  });

  it("waits while only modifiers are down and refuses what would swallow typing", () => {
    expect(shortcutFromKey(key("ControlLeft", { ctrlKey: true }, "Control"))).toEqual({ pending: true });
    expect(shortcutFromKey(key("KeyZ", {}, "z"))).toEqual({ invalid: true });
    expect(shortcutFromKey(key("KeyZ", { shiftKey: true }, "Z"))).toEqual({ invalid: true });
    expect(shortcutFromKey(key("NumpadEnter", { ctrlKey: true }, "Enter"))).toEqual({ invalid: true });
  });
});

describe("shortcutLabel", () => {
  it("reads like the keys", () => {
    expect(shortcutLabel("Ctrl+Alt+Space")).toBe("Ctrl + Alt + Space");
    expect(shortcutLabel("Super+F2")).toBe("Win + F2");
    expect(shortcutLabel("")).toBe("关闭");
  });
});

describe("clipboardText", () => {
  const page = "回复要点：  \r\n- 掉落表按权重\t\n\n- 周五发版\n\n\n";
  it("keeps the lines with Windows line breaks by default", () => {
    expect(clipboardText(page, false)).toBe("回复要点：\r\n- 掉落表按权重\r\n\r\n- 周五发版");
  });
  it("joins the lines into one with 安全换行", () => {
    expect(clipboardText(page, true)).toBe("回复要点： - 掉落表按权重 - 周五发版");
    expect(clipboardText("  缩进\n    下一行", true)).toBe("  缩进 下一行");
  });
  it("leaves a single line alone", () => {
    expect(clipboardText("一行", false)).toBe("一行");
    expect(clipboardText("一行", true)).toBe("一行");
  });
});

