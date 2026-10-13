import { createContext, useContext, useEffect, useState } from "react";
import type { MessageImage } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { attachmentUrl } from "../lib/attachments.js";
import { copyText } from "../host/client.js";
import { baseName, dirName } from "./refs.js";
import { IconFile } from "./icons.js";
import { FileLink } from "../files/FileLinks.js";

// What a person's message carries besides its text, as the transcript shows it: image thumbnails (click for a larger
// view) and chips of the referenced files.

/** The Host link, for loading attachment images in the transcript (provided by the conversation). */
export const AttachLink = createContext<HostLink | null>(null);

export function MessageImages({ images }: { images: readonly MessageImage[] }) {
  const link = useContext(AttachLink);
  const [open, setOpen] = useState<string | null>(null);
  if (!images.length) return null;
  const src = (img: MessageImage) => (img.id && link ? attachmentUrl(link, img.id) : null);
  return (
    <div className="msg-images" data-testid="msg-images">
      {images.map((img, i) => {
        const url = src(img);
        return url ? (
          <button key={`${img.path}-${i}`} type="button" className="msg-image" title="查看大图" onClick={() => setOpen(url)}>
            <img src={url} alt={baseName(img.path)} loading="lazy" />
          </button>
        ) : (
          <span key={`${img.path}-${i}`} className="file-chip" title={img.path}>
            <IconFile />
            <span className="file-chip-name">{baseName(img.path)}</span>
          </span>
        );
      })}
      {open && <Lightbox src={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * Referenced files: name first, folder dimmed. In a conversation with file links (stage 12) a click opens the quick
 * look; otherwise, or while the file is not found, a click copies the path.
 */
export function MessageFiles({ files }: { files: readonly string[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!files.length) return null;
  const chip = (path: string, label: string, dir: boolean) => (
    <>
      <IconFile />
      <span className="file-chip-name">{label}</span>
      {dir && dirName(path) && <span className="file-chip-dir">{dirName(path)}</span>}
    </>
  );
  return (
    <div className="msg-files" data-testid="msg-files">
      {files.map((path) => (
        <FileLink
          key={path}
          path={path}
          className="file-chip"
          testId="msg-file"
          fallback={
            <button
              type="button"
              className="file-chip"
              data-testid="msg-file"
              title={`${path}\n点击复制路径`}
              onClick={() => {
                void copyText(path);
                setCopied(path);
                setTimeout(() => setCopied((c) => (c === path ? null : c)), 1200);
              }}
            >
              {chip(path, copied === path ? "已复制路径" : baseName(path), copied !== path)}
            </button>
          }
        >
          {chip(path, baseName(path), true)}
        </FileLink>
      ))}
    </div>
  );
}

/** A large view over everything; Esc or a click closes it. */
export function Lightbox({ src, onClose }: { src: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label="查看图片" data-testid="lightbox" onClick={onClose}>
      <img src={src} alt="" />
    </div>
  );
}
