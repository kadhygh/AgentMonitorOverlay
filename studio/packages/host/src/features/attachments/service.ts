import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, type Attachment } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const ID = /^att-[0-9a-f-]{36}$/;

/**
 * Files Studio keeps for conversations and the scratchpad (stage 11): images pasted or dropped in. They live in the
 * data folder (`attachments/`, never in a project) as `<id><ext>` with a `<id>.json` beside it; agents get the path.
 */
export class AttachmentsFeature extends Feature {
  dir(): string {
    const db = this.store.path;
    return db === ":memory:" ? join(tmpdir(), "amo-studio-attachments") : join(dirname(db), "attachments");
  }

  save(data: Buffer, input: { name?: unknown; mime?: unknown }): Attachment {
    const mime = typeof input.mime === "string" ? input.mime.split(";")[0]!.trim().toLowerCase() : "";
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(mime)) throw new HostError("bad_request", `only images can be attached (${ATTACHMENT_MIMES.join(", ")})`);
    if (!data.length) throw new HostError("bad_request", "the file is empty");
    if (data.length > MAX_ATTACHMENT_BYTES) throw new HostError("bad_request", "file too large");
    const id = newId("att");
    const ext = EXT[mime]!;
    const raw = typeof input.name === "string" ? basename(input.name).trim() : "";
    const name = (raw || `image${ext}`).slice(0, 120);
    mkdirSync(this.dir(), { recursive: true });
    const path = join(this.dir(), id + ext);
    writeFileSync(path, data);
    const attachment: Attachment = { id, name, mime, size: data.length, path, createdAt: new Date().toISOString() };
    writeFileSync(join(this.dir(), `${id}.json`), JSON.stringify(attachment));
    return attachment;
  }

  /**
   * A file of any kind (2026-10-29 evening: what a paired device sends along with a remote message or task). Kept as
   * `<id>-<name>` so an agent reading the path sees the file's own name; agents get it in the 引用文件 block.
   */
  saveFile(data: Buffer, name: string): Attachment {
    if (data.length > MAX_ATTACHMENT_BYTES) throw new HostError("bad_request", "file too large");
    const id = newId("att");
    const safe = (basename(name).trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "file").slice(0, 120);
    mkdirSync(this.dir(), { recursive: true });
    const path = join(this.dir(), `${id}-${safe}`);
    writeFileSync(path, data);
    const attachment: Attachment = { id, name: safe, mime: "application/octet-stream", size: data.length, path, createdAt: new Date().toISOString() };
    writeFileSync(join(this.dir(), `${id}.json`), JSON.stringify(attachment));
    return attachment;
  }

  /** Gone with what it was for (a remote request refused or taken back); an unknown id is already gone. */
  remove(id: string): void {
    let a: Attachment;
    try {
      a = this.get(id);
    } catch {
      return;
    }
    rmSync(a.path, { force: true });
    rmSync(join(this.dir(), `${id}.json`), { force: true });
  }

  get(id: string): Attachment {
    if (!ID.test(id)) throw new HostError("not_found", `attachment ${id} not found`);
    const meta = join(this.dir(), `${id}.json`);
    if (!existsSync(meta)) throw new HostError("not_found", `attachment ${id} not found`);
    return JSON.parse(readFileSync(meta, "utf8")) as Attachment;
  }
}
