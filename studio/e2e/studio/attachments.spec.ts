import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 11 (S11-B): images and file references in the conversation — paste, drop from Explorer, the paperclip, how the
// transcript shows them. Real Codex app-server and the mock model, which says how many images it saw.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, dir: string, text = "hello") {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "附件", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text } });
  await s.page.getByTestId("task-card").first().click();
  await expect(s.page.getByTestId("task-title")).toHaveText("附件");
  await expect(lastAgent(s.page)).toContainText(`MOCK: ${text}`, { timeout: 30_000 });
  return { ws, ...created };
}

const composer = (page: Page) => page.getByLabel("输入消息");
const lastAgent = (page: Page) => page.getByTestId("msg-agent").last();

/** Pastes an in-memory PNG into the composer (or `into`), the way Ctrl+V with a screenshot does. */
async function pasteImage(page: Page, name = "截图.png", into = composer(page)) {
  await into.evaluate(
    (el, { b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { b64: TINY_PNG_BASE64, name },
  );
}

/**
 * Drops files from disk on the conversation, the way Explorer does: the files go through a file input first so that
 * they have a real path (Electron's webUtils reads it), then travel in a drop event's DataTransfer.
 */
async function dropFiles(page: Page, paths: string[]) {
  await page.evaluate(() => {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, id: "e2e-drop-source" });
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles("#e2e-drop-source", paths);
  await page.evaluate(() => {
    const input = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of input.files ?? []) dt.items.add(f);
    const target = document.querySelector('[data-testid="thread"]')!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    input.remove();
  });
}

test("pastes an image, sends it with the message, and shows it in the transcript", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, studio.workspace("alpha"));

  await pasteImage(page);
  const thumb = page.getByTestId("attach-thumb");
  await expect(thumb).toHaveCount(1);
  await expect(thumb).toHaveAttribute("data-state", "ready");
  // A second one, removed again with its ×.
  await pasteImage(page, "多余.png");
  await expect(thumb).toHaveCount(2);
  await page.getByRole("button", { name: "移除 多余.png" }).click();
  await expect(thumb).toHaveCount(1);
  // Before sending, a click on the thumbnail shows it large (2026-10-25); Esc closes only that.
  await thumb.getByRole("button", { name: /^查看大图/ }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await expect.poll(() => page.getByTestId("lightbox").locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await expect(thumb).toHaveCount(1);
  await composer(page).fill("这张图里是什么");
  await screenshot(studio.app, "stage-11", "S11-B-01-composer-image", page);
  await composer(page).press("Enter");

  await expect(lastAgent(page)).toContainText("MOCK: 这张图里是什么 [images: 1]", { timeout: 30_000 });
  await expect(thumb).toHaveCount(0);
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-images").locator("img")).toHaveCount(1);
  // The thumbnail really loads from the Host (?token=).
  await expect.poll(() => bubble.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await screenshot(studio.app, "stage-11", "S11-B-02-transcript-image", page);

  await bubble.getByTitle("查看大图").click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);

  // An image alone, without text, can be sent too.
  await pasteImage(page);
  await expect(thumb).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(lastAgent(page)).toContainText("[images: 1]", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").last().locator(".msg-text")).toHaveCount(0);
});

test("pastes an image into the new-task page: it goes with the first sentence (2026-10-19)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  const first = page.getByLabel("第一句话");
  await pasteImage(page, "截图.png", first);
  const thumb = page.getByTestId("attach-thumb");
  await expect(thumb).toHaveAttribute("data-state", "ready");
  await thumb.getByRole("button", { name: "查看大图 截图.png" }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.getByTestId("lightbox").click();
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await first.fill("这张图里是什么");
  // Filing in 待办 does not take images.
  await first.press("Control+Enter");
  await expect(page.getByRole("alert")).toContainText("放进待办不带图片");
  await screenshot(studio.app, "stage-18", "S18-newtask-image", page);
  await first.press("Enter");

  await expect(lastAgent(page)).toContainText("MOCK: 这张图里是什么 [images: 1]", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").first().getByTestId("msg-images").locator("img")).toHaveCount(1);
  // The page is empty again for the next task.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByTestId("attach-thumb")).toHaveCount(0);
});

test("drops an image and a file from disk: thumbnail, file reference, both in the transcript", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const png = join(dir, "diagram.png");
  const doc = join(dir, "notes.md");
  writeFileSync(png, Buffer.from(TINY_PNG_BASE64, "base64"));
  writeFileSync(doc, "# notes\n");
  await openTask(studio, dir);

  await dropFiles(page, [png, doc]);
  await expect(page.getByTestId("attach-thumb")).toHaveAttribute("data-state", "ready");
  const chip = page.getByTestId("file-chip");
  await expect(chip).toHaveText("notes.md");
  await expect(chip).toHaveAttribute("title", doc);
  await composer(page).fill("对照一下");
  await screenshot(studio.app, "stage-11", "S11-B-03-composer-drop", page);
  await composer(page).press("Enter");

  await expect(lastAgent(page)).toContainText("[images: 1]", { timeout: 30_000 });
  // The mock echoes the text it got: the reference block went to the model.
  await expect(lastAgent(page)).toContainText("引用文件：");
  await expect(lastAgent(page)).toContainText("notes.md");
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.locator(".msg-text")).toHaveText("对照一下");
  await expect(bubble.getByTestId("msg-file")).toContainText("notes.md");
  await screenshot(studio.app, "stage-11", "S11-B-04-transcript-files", page);
});

test("@ offers tasks, sessions and recent files; 找文件… and Ctrl+P open the file selector", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "app", "main.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "importer.py"), "import requests\n");
  writeFileSync(join(dir, "README.md"), "# alpha\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "README.md"), "# alpha, changed\n");
  writeFileSync(join(dir, "src", "new_feature.ts"), "");
  const { task } = await openTask(studio, dir);
  await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", text: "摸底" });
  await page.getByTestId("session-row").filter({ hasText: "hello" }).click();

  const suggest = page.getByTestId("suggest");
  await composer(page).pressSequentially("@");
  await expect(suggest).toContainText("任务");
  await expect(suggest.getByRole("option", { name: /摸底/ })).toBeVisible();
  await expect(suggest).toContainText("最近改动的文件");
  await expect(suggest.getByRole("option", { name: /README\.md/ })).toBeVisible();
  await expect(suggest.getByRole("option", { name: /new_feature\.ts/ })).toBeVisible();
  // 找文件… ends the files; 「AMO 扩展功能」 come last (10-26).
  await expect(suggest.locator('[data-kind="find"] + .suggest-h')).toHaveText("AMO 扩展功能");
  await expect(suggest.getByRole("option").last()).toContainText("提交并拉取");
  await screenshot(studio.app, "stage-11", "S11-B-05-at-menu", page);

  // A session keeps its name in the text; the message will say which session it is.
  await composer(page).pressSequentially("摸");
  await expect(suggest.getByRole("option").first()).toContainText("摸底");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("@摸底 ");
  // A file becomes a reference chip, and its @ text goes away.
  await composer(page).pressSequentially("看 @");
  await suggest.getByRole("option", { name: /README\.md/ }).click();
  await expect(page.getByTestId("file-chip")).toHaveAttribute("title", join(dir, "README.md"));
  await expect(composer(page)).toHaveValue("@摸底 看 ");
  // The picked name is coloured (10-22): a layer behind the textarea draws it, lined up with the textarea's text.
  const token = page.getByTestId("mention-backdrop").locator(".mention-token");
  await expect(token).toHaveText("@摸底");
  expect(await token.evaluate((el) => getComputedStyle(el).color)).not.toBe(await composer(page).evaluate((el) => getComputedStyle(el.parentElement!.querySelector(".mention-backdrop")!).color));
  const [box, area] = [await page.getByTestId("mention-backdrop").boundingBox(), await composer(page).boundingBox()];
  expect(box).toEqual(area);
  await screenshot(studio.app, "stage-18", "S18-mention-colour", page);

  // 找文件… opens the selector with what was typed after @.
  await composer(page).pressSequentially("@imp");
  await suggest.getByRole("option", { name: /找文件/ }).click();
  const picker = page.getByTestId("file-picker");
  await expect(picker.getByLabel("找文件")).toHaveValue("imp");
  await expect(picker.getByTestId("file-row").first()).toContainText("src/importer.py");
  await expect(picker.getByTestId("file-row").first().locator("mark")).toHaveText("imp");
  await screenshot(studio.app, "stage-11", "S11-B-06-file-picker", page);
  await picker.getByLabel("找文件").press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("file-chip")).toHaveCount(2);

  // Ctrl+P: the whole list, narrowed as you type; arrows move, Esc closes.
  await composer(page).press("Control+p");
  await expect(picker.getByTestId("file-row")).toHaveCount(4);
  await expect(picker.getByTestId("file-row").first()).toHaveAttribute("aria-selected", "true");
  await picker.getByLabel("找文件").press("ArrowDown");
  await expect(picker.getByTestId("file-row").nth(1)).toHaveAttribute("aria-selected", "true");
  await picker.getByLabel("找文件").fill("app main");
  await expect(picker.getByTestId("file-row")).toHaveCount(1);
  await expect(picker.getByTestId("file-row").first()).toContainText("src/app/main.ts");
  await picker.getByLabel("找文件").press("Escape");
  await expect(picker).toHaveCount(0);

  await composer(page).press("Enter");
  await expect(lastAgent(page)).toContainText("AMO 会话", { timeout: 30_000 });
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-file")).toHaveCount(2);
  await expect(bubble.getByTestId("msg-file").first()).toContainText("README.md");
  await expect(bubble.getByTestId("msg-file").last()).toContainText("importer.py");
});

test("@ 开子会话…: model and effort in a dialog, 「@子会话1」 in the text, and the message tells how to start it (2026-10-26)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const { session } = await openTask(studio, dir);
  // 设置 → 子会话 (2026-10-26): a note on the model, written on its page, goes with the setup.
  await page.getByRole("button", { name: "设置" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await settingsDialog.getByRole("tab", { name: "子会话" }).click();
  // Each channel lists its models as chips (10-26, no dropdowns): 「整个渠道」 of the session's channel.
  const channel = settingsDialog.locator(`[data-testid="subsession-channel"][data-profile="${session.profileId}"]`);
  await channel.getByTestId("subsession-chip").first().click();
  await expect(channel.getByTestId("subsession-note-text")).toBeFocused();
  await settingsDialog.getByTestId("subsession-note-text").fill("适合照计划改代码");
  await settingsDialog.getByTestId("subsession-note-text").blur();
  await expect.poll(async () => (await studio!.api<{ subsessionNotes: Array<{ note: string }> }>("GET", "/api/settings")).subsessionNotes.map((n) => n.note)).toEqual(["适合照计划改代码"]);
  await expect(channel.getByTestId("subsession-chip").first()).toHaveAttribute("aria-pressed", "true");
  await screenshot(studio.app, "stage-18", "S18-subsession-settings", page);
  await settingsDialog.getByRole("button", { name: "关闭设置" }).click();
  const suggest = page.getByTestId("suggest");
  await composer(page).pressSequentially("接下来开子会话就用 @");
  // Under「AMO 扩展功能」(10-26), after 找文件….
  await expect(suggest.getByText("AMO 扩展功能")).toBeVisible();
  await expect(suggest.getByRole("option").last()).toContainText("提交并拉取");
  await suggest.getByRole("option", { name: /开子会话…/ }).click();
  const dialog = page.getByTestId("subsession-dialog");
  await expect(dialog).toBeVisible();
  await expect(composer(page)).toHaveValue("接下来开子会话就用 ");
  await dialog.getByRole("button", { name: "完全放开" }).click();
  await dialog.getByTestId("subsession-report").uncheck();
  await expect(dialog.getByTestId("subsession-preview")).toContainText('permission: "full"，report: false');
  await expect(dialog.getByTestId("subsession-note")).toContainText("适合照计划改代码");
  await screenshot(studio.app, "stage-18", "S18-subsession-dialog", page);
  await dialog.getByTestId("subsession-ok").click();
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveValue("接下来开子会话就用 @子会话1 ");
  await expect(page.getByTestId("mention-backdrop").locator(".mention-token")).toHaveText("@子会话1");
  await composer(page).press("Enter");
  await expect
    .poll(async () => (await studio!.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)?.text ?? "", { timeout: 15_000 })
    .toContain("子会话的开法（要开时用 AMO 的 session_start");
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!.text!;
  expect(sent).toMatch(/- @子会话1：session_start 带 model: ".+"（.+），permission: "full"，report: false。人对这个模型的说明：适合照计划改代码/);
});
