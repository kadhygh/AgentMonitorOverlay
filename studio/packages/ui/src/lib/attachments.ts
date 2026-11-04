import { ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, type Attachment } from "@amo-studio/protocol";
import { request, type HostLink } from "../host/client.js";

// Images pasted or dropped into Studio (stage 11): uploaded to the Host, which keeps them in the data folder.

/** Whether a dropped or pasted file can be attached. */
export function attachable(file: Blob): boolean {
  return (ATTACHMENT_MIMES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES;
}

export async function uploadAttachment(link: HostLink, file: Blob, name = (file as File).name ?? ""): Promise<Attachment> {
  const query = new URLSearchParams({ type: file.type, ...(name ? { name } : {}) });
  return request<Attachment>(link, "POST", `/api/attachments?${query.toString()}`, file);
}

/** A URL an <img> can load (the token rides in the query; the Host only accepts that for attachments). */
export function attachmentUrl(link: HostLink, id: string): string {
  return `${link.url}/api/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(link.token)}`;
}

/** The images among pasted or dropped data. */
export function imagesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter(attachable);
}
