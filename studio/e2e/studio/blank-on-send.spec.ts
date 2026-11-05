import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, type Studio } from "../support/studio.js";

// 问题 #17 again (2026-11-05, s-055401cc): a message sent while the session was idle left the conversation area blank
// until the next reply came or the session was opened again. Probe: right after an idle send, frame by frame, whether
// what is in the viewport is drawn, and whether the conversation jumps. Found: the turn leaving the last three fell
// to its 300px stand-in (it had never remembered its size), ~1,350px shorter in this test at the moment of sending.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const filler = (n: number) => Array.from({ length: n }, (_, i) => `第${i}句话用来把对话撑长。`).join("");

async function send(page: Page, text: string) {
  await page.getByLabel("输入消息").fill(text);
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText(text.slice(0, 3), { timeout: 30_000 });
}

/** For ~60 frames after an idle send: per frame, the turns in the viewport and whether their content is skipped. */
function probe(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        let n = 0;
        const tick = () => {
          const thread = document.querySelector<HTMLElement>("[data-testid=thread]")!;
          const box = thread.getBoundingClientRect();
          const seen = [...thread.querySelectorAll<HTMLElement>("[data-testid=turn]")]
            .map((t, i) => ({ t, i, r: t.getBoundingClientRect() }))
            .filter(({ r }) => r.bottom > box.top && r.top < box.bottom)
            .map(({ t, i }) => `${i}${(t.firstElementChild as HTMLElement | null)?.checkVisibility({ contentVisibilityAuto: true }) === false ? "!skipped" : ""}`);
          const hits = [0.25, 0.5, 0.75].map((f) => document.elementFromPoint(box.left + box.width / 2, box.top + box.height * f)?.closest("[data-testid=turn]") ? "t" : "-").join("");
          out.push(`${n} top=${Math.round(thread.scrollTop)} h=${thread.scrollHeight} in=[${seen.join(",")}] hits=${hits}`);
          if (++n < 60) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test("an idle send leaves what is in view drawn", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "空闲发送", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: filler(120) } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").first()).toContainText("第119句", { timeout: 30_000 });
  for (let k = 2; k <= 6; k++) await send(page, `第${k}条 ${filler(120)}`);
  await expect(page.getByTestId("run-status")).toHaveCount(0, { timeout: 30_000 });

  await page.getByLabel("输入消息").fill(`第7条 ${filler(10)}`);
  const probing = probe(page);
  await page.getByLabel("输入消息").press("Enter");
  const frames = await probing;
  const bad = frames.filter((f) => f.includes("!skipped") || f.endsWith("hits=---"));
  expect(bad, bad.join("\n")).toEqual([]);
  // The conversation does not jump shorter as the turn leaving the last three starts skipping.
  const heights = frames.map((f) => Number(/ h=(\d+)/.exec(f)![1]));
  const drops = heights.slice(1).map((h, i) => heights[i]! - h);
  expect(Math.max(...drops), frames.join("\n")).toBeLessThan(200);
});
