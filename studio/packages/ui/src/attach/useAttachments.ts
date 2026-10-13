import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { HostLink } from "../host/client.js";
import { attachable, imagesOf, uploadAttachment } from "../lib/attachments.js";

// What the composer holds besides its text: images pasted or dropped in (uploaded at once, sent by id) and file
// references (paths, sent as a block at the end of the message).

export interface PendingImage {
  key: string;
  name: string;
  /** A local object URL, so the thumbnail shows before the upload ends. */
  preview: string;
  state: "uploading" | "ready" | "failed";
  /** The attachment id once uploaded. */
  id?: string;
  error?: string;
}

/** What `take()` hands over for sending, and `restore()` puts back if sending failed. */
export interface ComposerAttachments {
  images: PendingImage[];
  files: string[];
}

/**
 * The real path of a dropped or picked file (Electron's webUtils, through the preload); "" in a plain browser or for
 * a file that only exists in memory. Read from window.amo without widening its shared type.
 */
export function pathOfFile(file: File): string {
  const bridge = window.amo as { pathForFile?(file: File): string } | undefined;
  try {
    return bridge?.pathForFile?.(file) ?? "";
  } catch {
    return "";
  }
}

/** Whether a drag carries files (from Explorer, or another app). */
export const dragHasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");

let seq = 0;

export function useAttachments(link: HostLink) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Uploads finish after the list may have changed; the latest list decides whether the result still belongs.
  const live = useRef(new Set<string>());

  const addImages = useCallback(
    (list: readonly File[]) => {
      if (!list.length) return;
      const added = list.map((file) => ({ file, item: { key: `img-${++seq}`, name: file.name || "图片", preview: URL.createObjectURL(file), state: "uploading" as const } }));
      for (const a of added) live.current.add(a.item.key);
      setImages((cur) => [...cur, ...added.map((a) => a.item)]);
      for (const { file, item } of added) {
        uploadAttachment(link, file)
          .then((att) => live.current.has(item.key) && setImages((cur) => cur.map((i) => (i.key === item.key ? { ...i, state: "ready", id: att.id } : i))))
          .catch((err: unknown) =>
            live.current.has(item.key) && setImages((cur) => cur.map((i) => (i.key === item.key ? { ...i, state: "failed", error: err instanceof Error ? err.message : String(err) } : i))),
          );
      }
    },
    [link],
  );

  const addFiles = useCallback((paths: readonly string[]) => {
    const clean = paths.map((p) => p.trim()).filter(Boolean);
    if (clean.length) setFiles((cur) => [...new Set([...cur, ...clean])]);
  }, []);

  /** Images become thumbnails; other files (and images too big or of another type) become path references. */
  const addDropped = useCallback(
    (list: readonly File[]) => {
      const pics = list.filter(attachable);
      const others = list.filter((f) => !attachable(f));
      addImages(pics);
      const paths = others.map(pathOfFile);
      addFiles(paths);
      const missing = paths.filter((p) => !p).length;
      setNotice(missing ? `有 ${missing} 个文件拿不到路径，没有加入引用` : null);
    },
    [addImages, addFiles],
  );

  const removeImage = (key: string) => {
    live.current.delete(key);
    setImages((cur) => {
      const gone = cur.find((i) => i.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return cur.filter((i) => i.key !== key);
    });
  };
  const removeFile = (path: string) => setFiles((cur) => cur.filter((p) => p !== path));

  /** Hands everything over for sending and empties the composer (the previews stay valid until `release`). */
  const take = (): ComposerAttachments => {
    const out = { images, files };
    setImages([]);
    setFiles([]);
    setNotice(null);
    return out;
  };
  const restore = (a: ComposerAttachments) => {
    for (const i of a.images) live.current.add(i.key);
    setImages((cur) => [...a.images, ...cur]);
    setFiles((cur) => [...new Set([...a.files, ...cur])]);
  };
  const release = (a: ComposerAttachments) => {
    for (const i of a.images) {
      live.current.delete(i.key);
      URL.revokeObjectURL(i.preview);
    }
  };
  const reset = useCallback(() => {
    setImages((cur) => {
      for (const i of cur) URL.revokeObjectURL(i.preview);
      return [];
    });
    live.current.clear();
    setFiles([]);
    setNotice(null);
  }, []);
  useEffect(() => reset, [reset]);

  return {
    images,
    files,
    notice,
    empty: !images.length && !files.length,
    uploading: images.some((i) => i.state === "uploading"),
    failed: images.some((i) => i.state === "failed"),
    addImages,
    addFiles,
    addDropped,
    removeImage,
    removeFile,
    take,
    restore,
    release,
    reset,
    /** Ctrl+V: pasted images are attached; text still pastes as usual. */
    onPaste(e: ClipboardEvent) {
      const pics = imagesOf(e.clipboardData);
      if (!pics.length) return;
      if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
      addImages(pics);
    },
    onDragOver(e: DragEvent): boolean {
      if (!dragHasFiles(e)) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return true;
    },
    onDrop(e: DragEvent): boolean {
      if (!e.dataTransfer.files.length) return false;
      e.preventDefault();
      addDropped([...e.dataTransfer.files]);
      return true;
    },
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;
