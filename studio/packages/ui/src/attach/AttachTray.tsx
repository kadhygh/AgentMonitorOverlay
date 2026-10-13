import type { AttachmentsState } from "./useAttachments.js";
import { baseName } from "./refs.js";
import { IconClose, IconFile } from "./icons.js";
import { FileLink } from "../files/FileLinks.js";

/** Above the composer's text: thumbnails of the images and chips of the referenced files, each with a remove ×. */
export function AttachTray({ attach, disabled }: { attach: AttachmentsState; disabled?: boolean }) {
  if (attach.empty && !attach.notice) return null;
  return (
    <div className="attach-tray" data-testid="attach-tray">
      {attach.images.map((img) => (
        <div
          key={img.key}
          className="attach-thumb"
          data-state={img.state}
          data-testid="attach-thumb"
          title={img.state === "failed" ? `上传失败：${img.error ?? ""}` : img.state === "uploading" ? "上传中…" : img.name}
        >
          <img src={img.preview} alt={img.name} />
          {img.state === "uploading" && <span className="attach-thumb-state">上传中</span>}
          {img.state === "failed" && <span className="attach-thumb-state">失败</span>}
          <button type="button" className="attach-x" aria-label={`移除 ${img.name}`} disabled={disabled} onClick={() => attach.removeImage(img.key)}>
            <IconClose />
          </button>
        </div>
      ))}
      {attach.files.map((path) => (
        <span key={path} className="file-chip" data-testid="file-chip" title={path}>
          <IconFile />
          <FileLink path={path}>
            <span className="file-chip-name">{baseName(path)}</span>
          </FileLink>
          <button type="button" className="attach-x inline" aria-label={`移除引用 ${baseName(path)}`} disabled={disabled} onClick={() => attach.removeFile(path)}>
            <IconClose />
          </button>
        </span>
      ))}
      {attach.notice && <span className="attach-notice">{attach.notice}</span>}
    </div>
  );
}
