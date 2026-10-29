import { describe, expect, it } from "vitest";
import { MENU_SIZES, menuHeight, menuHtml, type MenuEntry } from "./html.js";

describe("tray menu page", () => {
  const entries: MenuEntry[] = [
    { kind: "title", label: "AMO Studio" },
    { kind: "item", label: "打开 Studio", strong: true, run: () => undefined },
    { kind: "rule" },
    { kind: "item", label: "单击图标：打开 <便签>", checked: true, run: () => undefined },
    { kind: "item", label: "单击图标：打开 Studio", checked: false, run: () => undefined },
  ];

  it("fits the window to its entries", () => {
    expect(menuHeight(entries)).toBe(MENU_SIZES.chrome + MENU_SIZES.title + 3 * MENU_SIZES.item + MENU_SIZES.rule);
  });

  it("draws titles, items (strong, choices with ✓), rules, each item by its index; labels escaped", () => {
    const html = menuHtml(entries, "平台菜单");
    expect(html).toContain(`<div class="t">AMO Studio</div>`);
    expect(html).toContain(`class="i s" data-i="1">打开 Studio</button>`);
    expect(html).toContain(`role="menuitemradio" aria-checked="true" class="i" data-i="3">单击图标：打开 &#60;便签&#62;<span class="k">✓</span>`);
    expect(html).toContain(`aria-checked="false" class="i" data-i="4">单击图标：打开 Studio<span class="k"></span>`);
    expect(html).toContain(`@media (prefers-color-scheme: light)`);
  });
});
