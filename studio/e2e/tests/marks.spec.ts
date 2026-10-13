import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { FileMark, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

// S12-D acceptance: the file marks window (标记文件 from the project's file selector, a pasted path, files dropped from
// Explorer; notes saved as typed; quick look; missing files; delete), and handing marks to a session — @ 标记的文件,
// a mark dragged into the composer, the sent message read back as chips that show the note.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const composer = (page: Page) => page.getByLabel("输入消息");
const lastAgent = (page: Page) => page.getByTestId("msg-agent").last();

async function openTask(s: Studio, dir: string) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "调掉落", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await s.page.getByTestId("task-card").first().click();
  await expect(s.page.getByTestId("task-title")).toHaveText("调掉落");
  await expect(lastAgent(s.page)).toContainText("MOCK: hello", { timeout: 30_000 });
  return { ws, ...created };
}

/** Opens the marks window from the task page and waits for it. */
async function openMarksWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.getByTestId("task-marks").click();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

function project(s: Studio): string {
  const dir = s.workspace("game");
  writeFileSync(join(dir, "drop.lua"), ["local M = {}", "M.rate = 0.25", "M.boss = 'Lv20'", "return M", ""].join("\n"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "boss.md"), "# Boss\n\n数值表\n");
  writeFileSync(join(dir, "old.lua"), "return nil\n");
  return dir;
}

/** Drops files from disk on the page the way Explorer does (a file input gives them real paths first). */
async function dropFiles(page: Page, paths: string[], selector: string) {
  await page.evaluate(() => {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, id: "e2e-drop-source" });
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles("#e2e-drop-source", paths);
  await page.evaluate((sel) => {
    const input = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of input.files ?? []) dt.items.add(f);
    const target = document.querySelector(sel)!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    input.remove();
  }, selector);
}

test("marks files in the marks window, edits their notes, looks at them and removes them", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = project(studio);
  const loose = studio.workspace("loose");
  writeFileSync(join(loose, "todo.txt"), "随手记\n");
  const { ws } = await openTask(studio, dir);

  // A window of its own (off-screen, never focused in tests), on the task's project.
  const marks = await openMarksWindow(app, page);
  expect(marks.url()).toContain(`#marks?workspace=${ws.id}`);
  await expect.poll(() => windowState(app, "marks")).toMatchObject({ visible: true, onScreen: false, anyFocused: false });
  await expect(marks.getByTestId("marks-empty")).toBeVisible();

  // + 标记文件: the project's file selector; Enter marks.
  await marks.getByTestId("marks-add").click();
  const picker = marks.getByTestId("file-picker");
  await picker.getByLabel("找文件").fill("drop");
  await expect(picker.getByTestId("file-row").first()).toContainText("drop.lua");
  await expect(picker).toContainText("回车标记");
  await picker.getByLabel("找文件").press("Enter");
  await expect(marks.getByTestId("toast")).toContainText("已标记 drop.lua");
  const rows = marks.getByTestId("mark-row");
  await expect(rows).toHaveCount(1);
  await expect(marks.getByTestId("marks-group").first()).toContainText("当前项目");

  // A pasted path (quoted, as Explorer's 复制文件地址 gives it), and a file dropped from Explorer outside every project.
  await marks.getByTestId("marks-paste").fill(`"${join(dir, "docs", "boss.md")}"`);
  await marks.getByTestId("marks-paste").press("Enter");
  await expect(rows).toHaveCount(2);
  await dropFiles(marks, [join(loose, "todo.txt")], ".mk-app");
  await expect(rows).toHaveCount(3);
  const groups = marks.getByTestId("marks-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.last()).toContainText("其他");
  await expect(groups.last()).toContainText("todo.txt");
  // The same file again is not marked twice.
  await marks.getByTestId("marks-paste").fill(join(dir, "drop.lua"));
  await marks.getByTestId("marks-paste").press("Enter");
  await expect(marks.getByTestId("toast")).toContainText("drop.lua 已经标记过");
  await expect(rows).toHaveCount(3);

  // The note saves as it is typed; the line range when the field is left.
  const drop = rows.filter({ hasText: "drop.lua" });
  await drop.getByTestId("mark-note").fill("掉落概率在这里，别动 boss 表");
  await expect(drop).toContainText("已保存");
  await drop.getByLabel("行号 drop.lua").fill("2-3");
  await drop.getByLabel("行号 drop.lua").press("Enter");
  await expect(drop).toContainText("第 2–3 行");
  const saved = await studio.api<FileMark[]>("GET", `/api/file-marks?workspace=${ws.id}`);
  expect(saved.find((m) => m.path.endsWith("drop.lua"))).toMatchObject({ note: "掉落概率在这里，别动 boss 表", startLine: 2, endLine: 3 });

  // Search over path and note.
  await marks.getByTestId("marks-search").fill("别动");
  await expect(rows).toHaveCount(1);
  await marks.getByTestId("marks-search").fill("");
  await expect(rows).toHaveCount(3);

  // 快速查看: the text with the marked lines.
  await drop.getByRole("button", { name: "快速查看" }).click();
  const look = marks.getByTestId("mark-quicklook");
  await expect(look).toContainText("M.rate = 0.25");
  await expect(look.locator(".mk-look-line.hit")).toHaveCount(2);
  await screenshot(app, "stage-12", "S12-D-quicklook", marks, "marks");
  await marks.keyboard.press("Escape");
  await expect(look).toHaveCount(0);
  // 在资源管理器中显示 (tests only record the launch).
  await drop.getByRole("button", { name: "在资源管理器中显示" }).click();
  await expect(marks.locator(".toast-error")).toHaveCount(0);

  // A file that is gone stays, greyed, once the list is read again.
  await marks.getByTestId("marks-paste").fill(join(dir, "old.lua"));
  await marks.getByTestId("marks-paste").press("Enter");
  await expect(rows).toHaveCount(4);
  rmSync(join(dir, "old.lua"));
  await rows.filter({ hasText: "boss.md" }).getByTestId("mark-note").fill("Boss 数值说明");
  const old = rows.filter({ hasText: "old.lua" });
  await expect(old).toHaveAttribute("data-missing", "true");
  await expect(old).toContainText("文件不存在");
  await expect(old.getByRole("button", { name: "快速查看" })).toBeDisabled();
  await screenshot(app, "stage-12", "S12-D-marks-window", marks, "marks");

  // 删除 asks once more.
  await old.getByTestId("mark-delete").click();
  await expect(old.getByTestId("mark-delete")).toHaveText("确认删除");
  await old.getByTestId("mark-delete").click();
  await expect(rows).toHaveCount(3);
});

test("hands marks to a session: @ 标记的文件, a mark dragged into the composer, and the note read back", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = project(studio);
  const { ws } = await openTask(studio, dir);
  await studio.api("POST", "/api/file-marks", { path: join(dir, "drop.lua"), startLine: 2, endLine: 3, note: "掉落概率在这里" });
  await studio.api("POST", "/api/file-marks", { path: join(dir, "docs", "boss.md"), note: "Boss 数值" });

  // @ lists the project's marks, matching the note too; picking one makes a chip that carries the note.
  const suggest = page.getByTestId("suggest");
  await composer(page).pressSequentially("看看 @掉落");
  await expect(suggest).toContainText("标记的文件");
  const option = suggest.locator('[data-kind="mark"]');
  await expect(option).toHaveCount(1);
  await expect(option).toContainText("drop.lua:2-3");
  await expect(option).toContainText("掉落概率在这里");
  await screenshot(app, "stage-12", "S12-D-at-menu", page);
  // (The task "调掉落" matches too and comes first.)
  await option.click();
  await expect(composer(page)).toHaveValue("看看 ");
  const chip = page.getByTestId("file-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("drop.lua:2-3");
  await expect(chip).toContainText("掉落概率在这里");

  // Dragging a row out of the marks window: what its dragstart puts on the drag, dropped on the composer. (Playwright
  // cannot drive a real OS drag between two windows; the two halves are played with the same DataTransfer types.)
  const marks = await openMarksWindow(app, page);
  const boss = marks.getByTestId("mark-row").filter({ hasText: "boss.md" });
  await expect(boss).toBeVisible();
  const carried = await boss.getByTestId("mark-drag").evaluate((el) => {
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return Object.fromEntries(dt.types.map((t) => [t, dt.getData(t)]));
  });
  expect(carried["text/plain"]).toBe(join(dir, "docs", "boss.md"));
  expect(Object.keys(carried)).toContain("application/x-amo-file-mark");
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    const target = document.querySelector(".composer-dock")!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, carried);
  await expect(chip).toHaveCount(2);
  await expect(chip.last()).toContainText("Boss 数值");
  await expect(composer(page)).toHaveValue("看看 ");

  // Sent: the message says which files and what the notes are; the transcript shows them as chips with the note.
  await composer(page).press("Enter");
  await expect(lastAgent(page)).toContainText("（说明：掉落概率在这里）", { timeout: 30_000 });
  await expect(lastAgent(page)).toContainText(`${join(dir, "drop.lua")}:2-3`);
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-file")).toHaveCount(2);
  await expect(bubble.getByTestId("msg-file").first()).toContainText("drop.lua:2-3");
  await expect(bubble.getByTestId("msg-file").first()).toContainText("掉落概率在这里");
  await expect(bubble.getByTestId("msg-file").last()).toContainText("Boss 数值");
  await expect(bubble).not.toContainText("引用文件：");
  await screenshot(app, "stage-12", "S12-D-sent", page);

  // 找文件 (Ctrl+P) can mark the highlighted file; the open marks window follows.
  await composer(page).press("Control+p");
  const picker = page.getByTestId("file-picker");
  await picker.getByLabel("找文件").fill("old");
  await expect(picker.getByTestId("file-row").first()).toContainText("old.lua");
  await picker.getByTestId("file-picker-mark").click();
  await expect(picker.getByTestId("file-picker-marked")).toHaveText("已标记 old.lua");
  await picker.getByLabel("找文件").press("Control+m");
  await expect(picker.getByTestId("file-picker-marked")).toHaveText("old.lua 已经标记过");
  await picker.getByLabel("找文件").press("Escape");
  await expect(marks.getByTestId("mark-row")).toHaveCount(3);

  // Ctrl+Shift+M and the top bar bring the same window back (one for all projects), on the project in front.
  const windows = app.windows().length;
  await page.locator("body").press("Control+Shift+M");
  await page.getByTestId("topbar-marks").click();
  await page.getByTestId("session-marks").click();
  await expect.poll(() => marks.url()).toContain(`#marks?workspace=${ws.id}`);
  expect(app.windows().length).toBe(windows);
});
