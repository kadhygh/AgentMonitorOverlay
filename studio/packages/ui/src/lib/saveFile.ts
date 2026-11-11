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

// 复制图片 (2026-11-11, the user: Reviewer 里打开的是图片时，按 Ctrl+C 直接把这张图片复制到剪贴板，复制的是图片本身，不是路径):
// read from the Host as 另存为 does, and put on the clipboard by the main process (clipboard.writeImage, reviewer/src/
// save-file.ts). Electron's nativeImage reads PNG and JPEG only; any other kind (GIF, WebP, BMP, SVG, ICO) is turned
// into PNG here from the <img> the page has already drawn (a canvas at the picture's own size; a GIF gives its first
// frame) — copying them too is what the person expects of a picture viewer, and a picture pasted is a bitmap anyway,
// rather than telling them the kind is not supported. A picture of a web page the canvas may not read (another
// origin) goes by its address: PNG or JPEG copy, others say why not.

/** PNG or JPEG by their first bytes: what Electron's nativeImage reads; null for other kinds. */
export function nativeImageKind(b: Uint8Array): "png" | "jpeg" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

/** The picture as the page drew it, as PNG; null when the canvas may not read it or it is too large to draw. */
async function drawnAsPng(img: HTMLImageElement | null): Promise<Uint8Array | null> {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    // Tainted by another origin.
    return null;
  }
}

/** Whether this window can put pictures on the clipboard (AMO's main process, or a browser's own clipboard). */
export const canCopyImages = () => !!window.amo?.copyImage || (typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write);

/** Copies the picture at `url` (drawn by `img`) to the clipboard as a picture; says how it went. */
export async function copyImage(url: string, img: HTMLImageElement | null): Promise<void> {
  let bytes: Uint8Array | null = null;
  try {
    const r = await fetch(url);
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch {
    // Another origin: drawn below, or read by the main process.
  }
  const png = bytes && nativeImageKind(bytes) ? bytes : await drawnAsPng(img);
  const fail = (why: string) => showToast({ text: `没有复制：${why}`, error: true });
  const copy = window.amo?.copyImage;
  try {
    if (copy) {
      const r = await copy(png ? { bytes: png } : { url });
      if (r.copied) showToast({ text: `已复制图片（${r.width} × ${r.height}），可以粘贴到别处了` });
      else fail(r.error ?? "复制不了这张图");
      return;
    }
    // A plain browser: its own clipboard takes PNG.
    if (!png || nativeImageKind(png) !== "png") return fail("这张图在这里复制不了");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png as BlobPart], { type: "image/png" }) })]);
    showToast({ text: "已复制图片，可以粘贴到别处了" });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Whether Ctrl+C belongs to text rather than the picture: the focus in a box (a comment being written, the find
 * box), or text selected on the page (the person's selection is copied as text, as always).
 */
export function textWantsCopy(doc: Document = document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (el && (el.matches?.("input, textarea, select, [contenteditable], [contenteditable] *") || el.isContentEditable)) return true;
  // A page in a frame keeps its own keys and selection.
  if (el?.tagName === "IFRAME") return true;
  const sel = doc.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== "";
}
