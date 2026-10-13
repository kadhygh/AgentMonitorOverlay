import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "./studio.js";

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

/** Pastes an in-memory PNG into the composer, the way Ctrl+V with a screenshot does. */
async function pasteImage(page: Page, name = "截图.png") {
  await composer(page).evaluate(
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
