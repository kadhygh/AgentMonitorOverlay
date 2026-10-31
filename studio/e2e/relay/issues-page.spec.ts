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
  await page.getByTestId("landing-issues").click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.getByPlaceholder("登录名").fill("老戴");
  await page.getByPlaceholder("密码").fill("pw-dai");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByTestId("issues-list")).toContainText("还没有问题");

  // Report: text, a dropped screenshot, the tool.
  await page.locator("#newBody").fill("任务里新会话的输入栏没有缓存\n切到别的任务再回来就空了");
  await drop(page, "#newForm");
  await expect(page.locator("#newThumbs .thumb:not(.up)")).toHaveCount(1);
  await page.locator("#newTool").selectOption("studio");
  await page.locator("#newVersion").fill("0.9.16");
  await page.locator("#newBody").press("Control+Enter");
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await expect(page.getByTestId("issues-detail")).toContainText("任务里新会话的输入栏没有缓存");
  await expect(page.getByTestId("issue-entry").first().locator("img")).toHaveCount(1);

  // 值守's AI (through the API, as Studio would) takes it and asks; the page picks it up by itself.
  await ai(me.key, "PATCH", "/api/issues/1", { status: "working", worker: "Opus 5.5 · 任务「问题 #1」", ai: true });
  await ai(me.key, "POST", "/api/issues/1/entries", { body: "是新建任务页的输入框，还是任务里点「新会话」之后的输入框？切走之前打了多少字？", ai: true, status: "asking" });
  await expect(page.getByTestId("issues-detail")).toContainText("还是任务里点「新会话」之后的输入框", { timeout: 15_000 });
  await expect(page.getByTestId("issue-row")).toContainText("等你回答");
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

  // A bigger one: the AI suggests talking it over; 要你看 lists it.
  await ai(me.key, "POST", "/api/issues", { title: "便签想支持多窗口", body: "每条便签能单独拖出来" });
  await ai(me.key, "POST", "/api/issues/2/entries", { body: "这牵涉便签的窗口模型和存储，不是顺手能改的，建议单开会话讨论方案。", ai: true, status: "discuss" });
  await expect(page.getByTestId("issues-tab-you")).toHaveText("要你看1", { timeout: 15_000 });
  await page.getByTestId("issues-tab-you").click();
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await expect(page.getByTestId("issue-row")).toContainText("建议单开讨论");
  await page.getByTestId("issue-row").click();
  await expect(page.locator("#commentText")).toHaveAttribute("placeholder", /想让 AI 直接修/);
  await page.screenshot({ path: join(shots, "I4-discuss.png") });

  // Dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(shots, "I3-dark.png") });
});
