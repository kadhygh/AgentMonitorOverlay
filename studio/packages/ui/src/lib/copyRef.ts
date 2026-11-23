import { taskRefText } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "./toast.js";

// 复制引用 (2026-11-23, 中转迭代讨论; protocol/src/refs.ts has the format, the same as the 中转 client's): a line to paste
// into an AI's conversation or to someone, and a notice saying what went onto the clipboard.

const failed = (err: unknown) => showToast({ text: `没复制上：${err instanceof HostApiError ? err.message : String(err)}`, error: true });

/** 复制会话引用: the Host writes it (the line carries this computer's device id). */
export async function copySessionRef(link: HostLink, sessionId: string): Promise<void> {
  try {
    const { text } = await call(link, "GET /api/sessions/:id/ref", { id: sessionId });
    await copyText(text);
    showToast({ text: `已复制会话引用：${text}`, testId: "copied-ref" });
  } catch (err) {
    failed(err);
  }
}

/** 复制任务编号. */
export async function copyTaskRef(title: string, taskId: string): Promise<void> {
  const text = taskRefText(title, taskId);
  try {
    await copyText(text);
    showToast({ text: `已复制任务编号：${text}`, testId: "copied-ref" });
  } catch (err) {
    failed(err);
  }
}
