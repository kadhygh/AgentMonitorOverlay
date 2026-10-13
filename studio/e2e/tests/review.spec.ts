import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { selectAndRightClick } from "./selection.js";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 2 acceptance: select → right-click annotate → send the summary back → the session receives it.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function annotate(page: Page, quote: string, note: string) {
  const reply = page.getByTestId("msg-agent").first();
  await selectAndRightClick(page, reply, quote);
  await page.getByRole("menu", { name: "选中文字" }).getByRole("menuitem", { name: "添加批注" }).click();
  const draft = page.getByTestId("annotation-draft");
  await draft.getByLabel("批注内容").fill(note);
  await draft.getByRole("button", { name: "保存" }).click();
  await expect(draft).toHaveCount(0);
}

test("annotate replies, edit, locate and send the summary back", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅闭环",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").first();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });

  await annotate(page, "发现 3 张表", "说明是哪三张");
  await annotate(page, "先修正概率", "先确认策划的意图");
  await annotate(page, "Boss_Lv20", "这条删掉");
  const cards = page.getByTestId("annotation");
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("annotation-count")).toHaveText("3");
  await expect(reply.locator("[data-annotated]")).toHaveCount(3);

  // Edit and delete.
  await cards.nth(1).getByRole("button", { name: "编辑" }).click();
  await cards.nth(1).getByLabel("修改批注").fill("先和策划确认意图再改");
  await cards.nth(1).getByRole("button", { name: "保存" }).click();
  await expect(cards.nth(1)).toContainText("先和策划确认意图再改");
  await cards.nth(2).getByRole("button", { name: "删除" }).click();
  await expect(cards).toHaveCount(2);
  await expect(reply.locator("[data-annotated]")).toHaveCount(2);

  // Clicking the quote locates and flashes the annotated block.
  await cards.nth(0).getByTitle("定位到原文").click();
  await expect(reply.locator(".md-flash")).toHaveCount(1);
  await expect(reply.locator(".md-flash")).toContainText("发现");
  await screenshot(studio.app, "stage-2", "S2-04-annotations", page);

  // Send the summary: one user message with both quotes in reply order; annotations fold into "已发送".
  await page.getByRole("button", { name: "汇总发回会话（2）" }).click();
  const summary = page.getByTestId("msg-user").filter({ hasText: "我有 2 条批注" });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toContainText("> 发现 3 张表");
  await expect(summary).toContainText("说明是哪三张");
  await expect(summary).toContainText("> 先修正概率");
  await expect(summary).toContainText("先和策划确认意图再改");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 针对你上面的回复", { timeout: 30_000 });
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId("annotation-count")).toHaveText("0");
  await expect(reply.locator("[data-annotated]")).toHaveCount(0);
  await page.getByRole("button", { name: /已发送 2/ }).click();
  await expect(page.getByTestId("annotation-sent")).toHaveCount(2);
  await screenshot(studio.app, "stage-2", "S2-04-sent", page);
});
