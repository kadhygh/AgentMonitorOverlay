// 账号's picture helpers (2026-10-28: editing the profile moved from the relay client to the platform). Moved from the
// relay client (packages/relay-ui: Chats.tsx's squareImage) and copied from its bits.tsx (avatarColor), so a person
// looks the same in both: the relay client still shows faces, it just no longer edits them.

const HUES = [18, 42, 160, 200, 230, 280, 330, 100];

/** The colour of someone's initial: picked from the account name, so it stays when the nickname changes (relay-ui's bits.tsx). */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 32% 42%)`;
}

/** The service keeps a picture of at most this many characters as a data: URL (relay store.setProfile). */
const MAX_CHARS = 96 * 1024;

/**
 * An image as a centred square of `size` px, JPEG, as a data: URL — small enough to keep with the member (the relay
 * client's 128 px at 0.85; lower qualities only if a picture still comes out over the service's limit).
 */
export async function squareImage(file: File, size = 128): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    if (!img.width || !img.height) throw new Error("empty image");
    const side = Math.min(img.width, img.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    // A transparent PNG on white, not black (JPEG has no transparency).
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    let out = canvas.toDataURL("image/jpeg", 0.85);
    for (const q of [0.7, 0.5]) if (out.length > MAX_CHARS) out = canvas.toDataURL("image/jpeg", q);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
