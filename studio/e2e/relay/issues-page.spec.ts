import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

// 问题页 (/issues, 2026-10-31, plans/issues.md) in a plain browser: sign in with the team account, report a problem with
// a dropped screenshot, see the AI's question (written through the API as Studio's 值守 would), answer it, 发布打包.

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const relay = (await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const shots = join(studio, "screenshots", "relay");
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAiklEQVR4nO3QQQmAQAAAwevi1xCCgQxlO3+CAWzg1xUHNsAyY1o3PTReP4gHCBAgQIDCAQIECBCgcOM6Dz0ECBAgQIDCAQIE6GWgfZm/FSBAgAABCgcoBvTzAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIW7ATRts3oWaHu8AAAAAElFTkSuQmCC";

let browser: Browser | undefined;
let root = "";
let store: InstanceType<typeof relay.RelayStore> | undefined;
let server: Awaited<ReturnType<typeof relay.startRelayServer>> | undefined;

test.afterEach(async () => {
  await browser?.close();
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function ai(key: string, method: string, path: string, body: unknown) {
  const res = await fetch(`${server!.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok).toBe(true);
}

async function drop(page: Page, target: string) {
  await page.evaluate(
    ({ b64, sel }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "截图.png", { type: "image/png" }));
      document.querySelector(sel)!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { b64: PNG_BASE64, sel: target },
  );
}

test("问题页: sign in, report with a screenshot, the AI asks, answer, 发布打包", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-issues-"));
  store = new relay.RelayStore(join(root, "relay.db"));
  server = await relay.startRelayServer({ store, filesDir: join(root, "files"), host: "127.0.0.1", port: 0, name: "测试组" });
  const me = await new relay.RelayClient(server.url).register("老戴", "pw-dai");

  // The system's Edge: e2e does not download a Chromium of its own.
  browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: "light" });
  await page.goto(`${server.url}/`);
  // Folded at the bottom under 维护工具 (2026-10-31).
  await expect(page.getByTestId("landing-issues")).toBeHidden();
  await page.screenshot({ path: join(shots, "I0-landing.png") });
  await page.getByTestId("landing-tools").locator("summary").click();
  await page.screenshot({ path: join(shots, "I0-landing-tools.png") });
  await page.getByTestId("landing-issues").click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.getByPlaceholder("登录名").fill("老戴");
  await page.getByPlaceholder("密码").fill("pw-dai");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByTestId("issues-list")).toContainText("还没有问题");

  // Report: opened on demand (2026-10-31 改版); text, a dropped screenshot, the tool.
  await expect(page.getByTestId("issues-new")).toBeHidden();
  await expect(page.getByTestId("issues-build")).toHaveText("现在没有在打包");
  await page.getByTestId("issues-new-toggle").click();
  await page.locator("#newBody").fill("任务里新会话的输入栏没有缓存\n切到别的任务再回来就空了");
  await drop(page, "#newForm");
  await expect(page.locator("#newThumbs .thumb:not(.up)")).toHaveCount(1);
  await page.locator("#newTool").selectOption("studio");
  await page.locator("#newVersion").fill("0.9.16");
  await page.locator("#newBody").press("Control+Enter");
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await expect(page.getByTestId("issues-detail")).toContainText("任务里新会话的输入栏没有缓存");
  await expect(page.getByTestId("issue-entry").first().locator("img")).toHaveCount(1);
  await expect(page.getByTestId("issues-new")).toBeHidden();

  // 值守's AI (through the API, as Studio would) takes it and asks; the page picks it up by itself.
  await ai(me.key, "PATCH", "/api/issues/1", { status: "working", worker: "Opus 5.5 · 任务「问题 #1」", ai: true });
  await ai(me.key, "POST", "/api/issues/1/entries", { body: "是新建任务页的输入框，还是任务里点「新会话」之后的输入框？切走之前打了多少字？", ai: true, status: "asking", session: "s-3173af00-39e8-4f99-8393-8b95d32e5704" });
  await expect(page.getByTestId("issues-detail")).toContainText("还是任务里点「新会话」之后的输入框", { timeout: 15_000 });
  await expect(page.getByTestId("issue-row")).toContainText("需要确认");
  // The session that took it, to copy into Studio's search (2026-10-31 晚).
  await expect(page.getByTestId("issue-session")).toHaveText("s-3173af00-39e8-4f99-8393-8b95d32e5704");
  await page.getByTestId("issue-session-copy").click();
  await expect(page.getByTestId("issue-session-copy")).toHaveText("已复制");
  await expect(page.getByTestId("issues-tab-you")).toHaveText("要你看1");
  await page.screenshot({ path: join(shots, "I1-asking.png") });

  // Answer with another screenshot.
  await page.locator("#commentText").fill("任务里点「新会话」之后的输入框，打了一句话就切走了");
  await drop(page, "[data-testid=issue-comment]");
  await expect(page.locator("[data-testid=issue-comment] .thumb:not(.up)")).toHaveCount(1);
  await page.locator("#commentText").press("Control+Enter");
  await expect(page.getByTestId("issue-entry")).toHaveCount(3);
  await expect(page.locator("#commentText")).toHaveValue("");
  await expect(page.getByTestId("issues-tab-you")).toHaveText("要你看");

  // Fixed by the AI, then 发布打包.
  await ai(me.key, "POST", "/api/issues/1/entries", { body: "修好了：新会话开好后草稿立刻按会话存下。", ai: true, status: "fixed" });
  await expect(page.getByTestId("issues-release")).toContainText("待发布 1 个", { timeout: 15_000 });
  await page.getByRole("button", { name: "发布打包" }).click();
  await expect(page.getByTestId("issues-release")).toContainText("已请求发布");
  await page.screenshot({ path: join(shots, "I2-release-requested.png") });

  // npm run release says where its build is (2026-10-31): each step its own bar, timed against the same step of the
  // last builds; a table of the last builds like Jenkins' stage view. Two earlier builds, as the service keeps them.
  const min = 60_000, t0 = Date.now() - 3 * 3600_000;
  const past = (at: number, ok: boolean, took: number[]) => ({ label: "AMO Studio 0.9.18", steps: ["类型检查", "单测", "提交版本", "打包", "发布"], step: ok ? 4 : took.length - 1, stepAt: took.map((_, k) => at + took.slice(0, k).reduce((a, b) => a + b, 0)), by: "老戴", startedAt: at, updatedAt: at, endedAt: at + took.reduce((a, b) => a + b, 0), ok, message: ok ? "已发到测试通道：AMO Studio 0.9.18" : "npm run package:platform: exit 1" });
  store!.db.prepare("INSERT INTO issue_meta (key, value) VALUES ('release.builds', ?)").run(JSON.stringify([past(t0 + 3600_000, true, [0.9 * min, 1.6 * min, 0.1 * min, 4.2 * min, 0.7 * min]), past(t0, false, [1 * min, 1.4 * min, 0.1 * min, 2 * min])]));
  await ai(me.key, "POST", "/api/issues/release/build", { start: { label: "AMO Studio 0.9.19", steps: ["类型检查", "单测", "提交版本", "打包", "发布"] } });
  await ai(me.key, "POST", "/api/issues/release/build", { step: 3 });
  await expect(page.getByTestId("issues-build")).toContainText("正在打包：AMO Studio 0.9.19 · 第 4/5 步「打包」", { timeout: 15_000 });
  await expect(page.getByTestId("issues-build")).toContainText("预计还要");
  await expect(page.locator("#stages .stage-name")).toHaveText(["✓ 类型检查", "✓ 单测", "✓ 提交版本", "◐ 打包", "○ 发布"]);
  // 打包 against its median (the one that got through it: 4 分 12 秒); 发布 not begun.
  await expect(page.locator("#stages .stage-time").nth(3)).toContainText("/ 约 4 分 12 秒");
  await expect(page.locator("#stages .stage-time").nth(4)).toHaveText("约 42 秒");
  await page.locator("#history summary").click();
  await expect(page.getByTestId("issues-build-row")).toHaveCount(3);
  await expect(page.getByTestId("issues-build-row").nth(1)).toContainText("✓ 成功");
  await expect(page.getByTestId("issues-build-row").nth(2)).toContainText("! 失败");
  await page.screenshot({ path: join(shots, "I5-building.png") });
  await ai(me.key, "POST", "/api/issues/release/build", { end: { ok: false, message: "npm run package:platform: exit 1" } });
  await expect(page.getByTestId("issues-build")).toContainText("上次打包停在「打包」", { timeout: 15_000 });
  await expect(page.locator("#stages .st-bad .stage-name")).toHaveText("! 打包");
  await page.locator("#history summary").click();

  // A longer issue folds the entries between the report and the last few; 展开 shows them.
  await ai(me.key, "POST", "/api/issues/1/entries", { body: "补一句：只在 Studio 刚启动时这样", ai: false });
  await ai(me.key, "POST", "/api/issues/1/entries", { body: "好，我再看看启动时的草稿读取", ai: true, status: "working" });
  await expect(page.getByTestId("issue-unfold")).toHaveText("展开前面 3 条来往", { timeout: 15_000 });
  await page.screenshot({ path: join(shots, "I6-folded.png") });
  await page.getByTestId("issue-unfold").click();
  await expect(page.getByTestId("issue-unfold")).toHaveCount(0);
  // 收起: the list alone again.
  await page.getByTestId("issue-close").click();
  await expect(page.getByTestId("issues-detail")).toBeHidden();
  await expect(page.getByTestId("issue-row").first()).toHaveAttribute("aria-current", "false");

  // A bigger one: the AI writes how it would go and asks to confirm (需要确认); the person would rather talk it over in
  // Studio: 前往讨论 hands it to them, 值守 leaves it alone, the session id shown to copy; 交回值守 gives it back.
  await ai(me.key, "POST", "/api/issues", { title: "便签想支持多窗口", body: "每条便签能单独拖出来" });
  await ai(me.key, "POST", "/api/issues/2/entries", { body: "这牵涉便签的窗口模型和存储，我想这样做：…… 你看行不行？", ai: true, status: "asking", session: "s-3a665306-3e14-425f-8bc4-e52ae057be8d" });
  await expect(page.getByTestId("issues-tab-you")).toHaveText("要你看1", { timeout: 15_000 });
  await page.getByTestId("issues-tab-you").click();
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await page.getByTestId("issue-row").click();
  await expect(page.locator("#commentText")).toHaveAttribute("placeholder", /确认、补充或者改主意/);
  await page.getByTestId("issue-discuss").click();
  await expect(page.getByTestId("issue-discuss-note")).toContainText("值守不再处理它");
  await expect(page.getByTestId("issue-discuss-note")).toContainText("s-3a665306-3e14-425f-8bc4-e52ae057be8d");
  await expect(page.getByTestId("issue-discuss")).toHaveText("交回值守");
  await expect(page.getByTestId("issues-tab-you")).toHaveText("要你看");
  await page.screenshot({ path: join(shots, "I4-discuss.png") });

  // Dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(shots, "I3-dark.png") });

  // A narrow window (the platform's): the list, or one issue in its place with 回列表.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 600, height: 820 });
  await expect(page.getByTestId("issues-list")).toBeHidden();
  await page.screenshot({ path: join(shots, "I7-narrow-issue.png") });
  await page.getByTestId("issue-close").click();
  await expect(page.getByTestId("issues-list")).toBeVisible();
  await page.screenshot({ path: join(shots, "I8-narrow-list.png") });
});
