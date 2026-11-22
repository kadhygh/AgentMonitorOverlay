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
  return `协作「${cowork.title}」${where ? `（${where}）` : ""}里的子会话。协作的目标：\n\n${cowork.goal || "（还没写）"}\n\n---\n\n${threadAsText(thread, messages)}`;
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
