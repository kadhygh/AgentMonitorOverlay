import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 发送后跳到最新 (2026-10-19): a message sent from the composer takes the conversation to its end wherever it was being
// read; 设置 → 界面 can turn that off, and then the reading place stays.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const filler = (n: number) => Array.from({ length: n }, (_, i) => `第${i}句话用来把对话撑长。`).join("");
const fromBottom = (page: Page) => page.getByTestId("thread").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const fromTop = (page: Page) => page.getByTestId("thread").evaluate((el) => el.scrollTop);

async function send(page: Page, text: string) {
  await page.getByLabel("输入消息").fill(text);
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText(text.slice(0, 3), { timeout: 30_000 });
}

test("sending jumps to the end of the conversation, unless turned off in 设置 → 界面", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "跟随", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: filler(80) } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").first()).toContainText("第79句", { timeout: 30_000 });
  await send(page, `第二条 ${filler(60)}`);

  // Reading near the top, a message sent goes to the end and the reply is followed.
  await page.getByTestId("thread").evaluate((el) => (el.scrollTop = 0));
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);
  await send(page, `第三条 ${filler(40)}`);
  await expect.poll(() => fromBottom(page)).toBeLessThan(40);

  // Off: the place being read stays.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "界面" }).click();
  await dialog.getByTestId("scroll-on-send-off").click();
  await expect(dialog.getByTestId("scroll-on-send-off")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("thread").evaluate((el) => (el.scrollTop = 0));
  await send(page, `第四条 ${filler(40)}`);
  expect(await fromTop(page)).toBeLessThan(50);
  expect(await page.evaluate(() => localStorage.getItem("amo.scrollOnSend"))).toBe("off");
});

// 问题 #17 (2026-11-04): just after a message is sent, the conversation read until then went blank for a while.
// The turns before the last few skip drawing off screen (content-visibility); the rule kept "the last two children",
// and while a turn runs the running line is one of them, so the reply on screen as the message went was switched to
// skipping at that very moment. The last turns are now marked and always drawn, the running line or not.
test("the reply on screen stays drawn when a message is sent", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "发送后不空白", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: filler(80) } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").first()).toContainText("第79句", { timeout: 30_000 });
  await send(page, `第二条 ${filler(60)}`);

  await page.getByLabel("输入消息").fill("[[slow]] 第三条");
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("run-status")).toBeVisible({ timeout: 10_000 });
  const turns = page.getByTestId("turn");
  await expect(turns).toHaveCount(3);
  // The turn read as the message went, and the one before it: drawn, not left to content-visibility.
  for (const k of [0, 1]) expect(await turns.nth(k).evaluate((el) => getComputedStyle(el).contentVisibility)).toBe("visible");
  await expect(turns.nth(1).getByTestId("msg-agent")).toBeInViewport();
  await screenshot(app, "studio", "issue17-sent-reply-stays", page);
  await expect(page.getByTestId("run-status")).toHaveCount(0, { timeout: 30_000 });
});
