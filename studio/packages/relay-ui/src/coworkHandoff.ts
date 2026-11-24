import { copyText, shell } from "./env.js";
import type { Cowork, Message, Thread } from "./shared.js";
import { threadAsText } from "./shared.js";

// 转到我的会话 (plans/cowork.md「B 一键转到自己的会话」, the way step 4 set it): the 子会话 goes to this computer's Studio
// through the shell's 在 Studio 里打开 — the mark `studio:<设备号>:cowork-to-<threadId>`; Studio asks which session takes it
// (or a new task), brings that session into the 协作, puts the text in and comes to the front. No shell change needed.
// Without it (a browser, a shell from before 传文件 that cannot say this computer's 设备号), or when Studio is closed or
// too old: the 子会话's text is copied, to paste into a session by hand.

/** The mark Studio's /api/ui/open takes as 「转到我的会话」. */
export const handoffMark = (device: string, threadId: string) => `studio:${device}:cowork-to-${threadId}`;

/** A Studio runs on this computer to take it (otherwise the button copies). */
export async function canHandToStudio(device: string | null, threadId: string): Promise<boolean> {
  if (!device || !shell?.openInStudio || !shell.studioHas) return false;
  return shell.studioHas(handoffMark(device, threadId)).catch(() => false);
}

export function handoffText(cowork: Pick<Cowork, "title" | "goal" | "repo" | "branch">, thread: Thread, messages: Message[]): string {
  const where = [cowork.repo, cowork.branch].filter(Boolean).join(" · ");
  return `协作「${cowork.title}」${where ? `（${where}）` : ""}里的一件事项。协作的目标：\n\n${cowork.goal || "（还没写）"}\n\n---\n\n${threadAsText(thread, messages)}`;
}

/** 转到我的会话: to Studio when it takes it; otherwise the text on the clipboard, with why it did not go. */
export async function toMySession(device: string | null, cowork: Cowork, thread: Thread, messages: Message[]): Promise<{ sent: true } | { sent: false; why: string | null }> {
  let why: string | null = null;
  if (device && shell?.openInStudio) {
    const r = await shell.openInStudio(handoffMark(device, thread.id));
    if (r === null) return { sent: true };
    // A Studio from before step 4 does not know the mark and says the session is gone.
    why = r.includes("没有这个会话") ? "这个版本的 Studio 还接不了，更新 Studio 后可以一键转过去" : r;
  }
  await copyText(handoffText(cowork, thread, messages));
  return { sent: false, why };
}

// 两头打通 (2026-11-25, plans/collab-framework.md「11-24」, links written there under 「中转客户端到 Studio 的链接」): the
// same road as 转到我的会话 — the shell's 在 Studio 里打开 with a mark Studio's POST /api/ui/open takes:
//   studio:<设备号>:cowork-lead-<coworkId>    在我的 Studio 里开这一方的主控 (a new task with the goal, 已定的事 and the
//                                             board; its first session joins this 协作 as my side's 主控)
//   studio:<设备号>:cowork-patrol-<coworkId>  让主控现在看一遍 (Host works out my 主控's 待我处理 now, not at the next round)
export const leadMark = (device: string, coworkId: string) => `studio:${device}:cowork-lead-${coworkId}`;
export const patrolMark = (device: string, coworkId: string) => `studio:${device}:cowork-patrol-${coworkId}`;

/** Studio on this computer takes these (the button is offered); null: why not, in words. */
export async function studioHere(device: string | null): Promise<string | null> {
  if (!shell?.openInStudio) return "在桌面客户端里才能跳到 Studio";
  if (!device) return "这个中转客户端还说不出这台电脑是哪台：更新中转客户端后再试";
  if (!shell.studioHas) return null;
  return (await shell.studioHas(`studio:${device}:probe`).catch(() => false)) ? null : "这台电脑的 Studio 没开着";
}

/** Asks Studio; the toast says how it went (an older Studio does not know the mark: it says so). */
export async function askStudio(mark: string, done: string, toast: (t: string) => void): Promise<void> {
  if (!shell?.openInStudio) return toast("在桌面客户端里才能跳到 Studio");
  const why = await shell.openInStudio(mark).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
  if (why === null) return toast(done);
  toast(why.includes("没有这个会话") || why.includes("还不支持") ? "这个版本的 Studio 还接不了：更新 Studio 后再试" : `没能交给 Studio：${why}`);
}
