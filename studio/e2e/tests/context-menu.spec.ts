import { expect, test } from "@playwright/test";
import type { Annotation, Session, Task, Workspace } from "@amo-studio/protocol";
import { selectAndRightClick } from "./selection.js";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openMarkdownReply(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await s.page.getByTestId("task-card").first().click();
  const reply = s.page.getByTestId("msg-agent").last();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  return { reply, session: created.session };
}

test("selection menu: annotate, quote into the composer, copy", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { reply, session } = await openMarkdownReply(studio);
  const menu = page.getByRole("menu", { name: "选中文字" });

  // 添加批注: the draft card shows the quote; saving stores it with its source range and context.
  await selectAndRightClick(page, reply, "发现 3 张表");
  await expect(menu).toBeVisible();
  await screenshot(studio.app, "stage-2", "S2-03-context-menu", page);
  await menu.getByRole("menuitem", { name: "添加批注" }).click();
  await expect(menu).toHaveCount(0);
  const draft = page.getByTestId("annotation-draft");
  await expect(draft).toContainText("「发现 3 张表」");
  await draft.getByLabel("批注内容").fill("这里应该说明是哪三张");
  await draft.getByRole("button", { name: "保存" }).click();
  await expect(draft).toHaveCount(0);
  const [saved] = await studio.api<Annotation[]>("GET", `/api/sessions/${session.id}/annotations`);
  expect(saved).toMatchObject({ quote: "发现 3 张表", note: "这里应该说明是哪三张", sentAt: null });
  const item = (await studio.api<Array<{ id: string; type: string; markdown?: string }>>("GET", `/api/sessions/${session.id}/items`)).find((i) => i.id === saved!.itemId)!;
  expect(item.markdown!.slice(saved!.start, saved!.end)).toBe("发现 **3** 张表");

  // 引用到输入框
  await selectAndRightClick(page, reply, "先修正概率");
  await menu.getByRole("menuitem", { name: "引用到输入框" }).click();
  await expect(page.getByLabel("输入消息")).toHaveValue("> 先修正概率\n\n");

  // 复制
  await selectAndRightClick(page, reply, "Boss_Lv20");
  await menu.getByRole("menuitem", { name: "复制" }).click();
  // Test mode records copies instead of overwriting the user's clipboard.
  await expect.poll(() => studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1))).toBe("Boss_Lv20");

  // Escape closes; selections outside a reply get no menu.
  await selectAndRightClick(page, reply, "校验结果");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await selectAndRightClick(page, page.getByTestId("msg-user").first(), "markdown");
  await expect(menu).toHaveCount(0);
});
