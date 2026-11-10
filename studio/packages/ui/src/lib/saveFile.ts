import { showToast } from "./toast.js";

// 另存为 (2026-11-11, the user: 图片上按右键…可以「另存为…」，弹出系统的保存对话框选位置): the page reads the file itself —
// the Host serves it, this computer's or a remote task's copy (the same origin, so no CORS) — and hands the bytes to
// the main process, which asks where (reviewer/src/save-file.ts). A picture from the web the page cannot read goes by
// its address. Without AMO's main process (a plain browser), the browser's own download.

const nameOk = (name: string) => name.trim() || "图片";

/** Asks where to save `url` as `name` and saves it there; says how it went. */
export async function saveFileAs(url: string, name: string): Promise<void> {
  const save = window.amo?.saveFile;
  if (!save) {
    const a = document.createElement("a");
    a.href = url;
    a.download = nameOk(name);
    a.click();
    return;
  }
  let bytes: Uint8Array | null = null;
  try {
    const r = await fetch(url);
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch {
    // Not readable from here (another origin): the main process reads it by its address.
  }
  try {
    const r = await save({ name: nameOk(name), ...(bytes ? { bytes } : { url }) });
    if (r.saved) showToast({ text: `已保存：${r.path ?? nameOk(name)}` });
    else if (r.error) showToast({ text: `没有保存：${r.error}`, error: true });
  } catch (err) {
    showToast({ text: `没有保存：${err instanceof Error ? err.message : String(err)}`, error: true });
  }
}
