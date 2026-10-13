import { ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, type Attachment, type HostErrorBody } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";

// Images pasted or dropped into Studio (stage 11): uploaded to the Host, which keeps them in the data folder.

/** Whether a dropped or pasted file can be attached. */
export function attachable(file: Blob): boolean {
  return (ATTACHMENT_MIMES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES;
}

export async function uploadAttachment(link: HostLink, file: Blob, name = (file as File).name ?? ""): Promise<Attachment> {
  const query = new URLSearchParams({ type: file.type, ...(name ? { name } : {}) });
  const res = await fetch(`${link.url}/api/attachments?${query.toString()}`, {
    method: "POST",
    headers: { authorization: `Bearer ${link.token}`, "content-type": file.type },
    body: file,
  });
  const data = (await res.json()) as Attachment | HostErrorBody;
  if (!res.ok) {
    const err = (data as HostErrorBody).error;
    throw new HostApiError(res.status, err?.code ?? "internal", err?.message ?? res.statusText);
  }
  return data as Attachment;
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
